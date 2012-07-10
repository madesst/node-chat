var http = require('http');
var url = require('url');
var fs = require('fs');
var io = require('socket.io');

var session = require('sesh/lib/core').magicSession();
var cloner = require('cloneextend');
var cookie = require('cookie');
var amqp = require('amqp');

var httpserver = http.createServer(handler);
var socketioserver = io.listen(httpserver).set('log level', 2);

var REDIS_KEY = 'redis_key';
var CHAT_PUBLIC_EXCHANGE_NAME = 'chat.public.exchange';
var CHAT_PRIVATE_EXCHANGE_NAME = 'chat.private.exchange';
var CHAT_TRANSFERS_EXCHANGE_NAME = 'chat.transfers.exchange';
var CHAT_SYSTEM_EXCHANGE_NAME = 'chat.system.exchange';

var CHAT_PUBLIC_QUEUE_NAME = 'chat.public';
var CHAT_PRIVATE_QUEUE_NAME = 'chat.private';
var CHAT_TRANSFERS_QUEUE_NAME = 'chat.transfers';
var CHAT_AMQP_QUEUE_CONFIG = {durable: true, autoDelete: true};
var CHAT_AMQP_CONNECTION_CONFIG = { host: 'localhost', login: 'guest', password: 'guest' };
var CHAT_DEFAULT_USER = {nickname: 'Guest', current_room: null, old_room: null};

var socketUsers = [];//my redis :)
var socketConnections = [];

function join_room(amqp_connection, current_user, socket, data)
{
	amqp_connection.queue(CHAT_TRANSFERS_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(transfer_queue){
		amqp_connection.exchange(CHAT_TRANSFERS_EXCHANGE_NAME, {type: 'topic', durable: true}, function (transfer_exchange) {

			console.log(CHAT_TRANSFERS_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id,
					CHAT_TRANSFERS_EXCHANGE_NAME,
					current_user.nickname);
			transfer_queue.bind(transfer_exchange, current_user.nickname);

			var transfer_info = JSON.parse(data);

			transfer_queue.subscribe(function (message, headers, deliveryInfo) {

				//Transfer message handler
				if(current_user.current_room) {
					current_user.old_room = current_user.current_room;
				}
				current_user.current_room = message.to;

				//Rebind user public queue on new room
				amqp_connection.queue(CHAT_PUBLIC_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(public_queue){
					amqp_connection.exchange(CHAT_PUBLIC_EXCHANGE_NAME, {type: 'topic', durable: true}, function (public_exchange) {

						if(current_user.old_room) {
							public_queue.unbind(public_exchange, current_user.old_room + '.#');
						}

						public_queue.bind(public_exchange, current_user.current_room + '.#');

						public_queue.subscribe(function (message, headers, deliveryInfo) {

							//Public message handler
							socket.send(JSON.stringify({
								message: message.message,
								type: 'public',
								from: message.from,
								to: message.to
							}));
						}).addCallback(function(){
									if(current_user.old_room) {
										public_exchange.publish(current_user.old_room+'.'+current_user.nickname, {message: 'has moved to ' + current_user.current_room, from: current_user.nickname, to: ''}, {contentType: 'application/json'});
									} else {
										//Ack to client-side
										socket.emit('chat_connect_complete', JSON.stringify({
											current_user: current_user
										}));
									}

									public_exchange.publish(current_user.current_room+'.'+current_user.nickname, {message: 'has come to ' + current_user.current_room, from: current_user.nickname, to: ''}, {contentType: 'application/json'});

									//Ack to client-side
									socket.emit('join_room_complete', JSON.stringify({
										current_room: current_user.current_room
									}));
								});
					});
				});
			}).addCallback(function(){
						transfer_exchange.publish(current_user.nickname, {from: current_user.nickname, to: transfer_info.chat_room});
					});
		});
	});
}

socketioserver.sockets.on('connection', function(socket) {
	var private_exchange, amqp_connection;


	socket.on('join_room', function(data) {
		if(socketUsers[socketConnections[socket.id]]) {
			var current_user = socketUsers[socketConnections[socket.id]];
			console.log(current_user);
			join_room(amqp_connection, current_user, socket, data);
		}
	});


	socket.on('chat_connect', function(data) {
		socketConnections[socket.id] = cookie.parse(data)[REDIS_KEY];
		if(socketUsers[socketConnections[socket.id]]) {
			var current_user = socketUsers[socketConnections[socket.id]];
		} else {
			var current_user = cloner.clone(CHAT_DEFAULT_USER);
			socketUsers[socketConnections[socket.id]] = current_user;
		}

		console.log(socketConnections[socket.id]);

		amqp_connection = amqp.createConnection(CHAT_AMQP_CONNECTION_CONFIG);
		amqp_connection.on('ready', function () {

			//Connect to private channel
			amqp_connection.queue(CHAT_PRIVATE_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(q){
				amqp_connection.exchange(CHAT_PRIVATE_EXCHANGE_NAME, {type: 'topic', durable: true}, function (exchange) {
					private_exchange = exchange;
					q.bind(private_exchange, '#.'+current_user.nickname+'.#');

					q.subscribe(function (message, headers, deliveryInfo) {
						//Private message handler
						socket.send(JSON.stringify({
							message: message.message,
							type: 'private',
							from: message.from,
							to: message.to
						}));
					}).addCallback(function(){
								join_room(amqp_connection, current_user, socket, JSON.stringify({chat_room: 'someroom'}));
							});
				});
			});
		});
	});

	socket.on('message', function(data) {
		var msg = JSON.parse(data);
		if(message == 'undefined'){
			return false;
		}

		if(!socketUsers[socketConnections[socket.id]]) {
			return false;
		}

		var current_user = socketUsers[socketConnections[socket.id]];

		var recipients = '';
		var message = msg.message;
		var exchanger = CHAT_PUBLIC_EXCHANGE_NAME;
		var routing_key = current_user.current_room+'.'+current_user.nickname;

		var type_private_check = message.match(/private\s\[(.*)\]\s(.*)/);
		if(type_private_check){//Private message
			recipients = type_private_check[1]; message = type_private_check[2];
			routing_key = current_user.nickname+'.'+recipients;
			exchanger = CHAT_PRIVATE_EXCHANGE_NAME;
		} else{//Public message
			var type_to_check = message.match(/to\s\[(.*)\]\s(.*)/);
			if(type_to_check) { recipients = type_to_check[1]; message = type_to_check[2]; }
		}

		amqp_connection.exchange(exchanger, {type: 'topic', durable: true}, function (exchange) {
			exchange.publish(routing_key, {message: message, from: current_user.nickname, to: recipients}, {contentType: 'application/json'});
		});
	});

	socket.on('disconnect', function() {
		//TODO: drop key from redis
		console.log('disconnect!!!');
		if(!socketUsers[socketConnections[socket.id]]) {
			return true;
		}
		var current_user = socketUsers[socketConnections[socket.id]];

		console.log(current_user);

		amqp_connection.queue(CHAT_PUBLIC_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(public_queue){
			amqp_connection.exchange(CHAT_PUBLIC_EXCHANGE_NAME, {type: 'topic', durable: true}, function (public_exchange) {
				if(current_user.old_room) {
					public_queue.unbind(public_exchange, current_user.old_room + '.#');
				}
			});
		});

		amqp_connection.queue(CHAT_PRIVATE_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(private_queue){
			amqp_connection.exchange(CHAT_PRIVATE_EXCHANGE_NAME, {type: 'topic', durable: true}, function (private_exchange) {
				private_queue.unbind(private_exchange, '#.'+current_user.nickname+'.#');
			});
		});

		amqp_connection.queue(CHAT_TRANSFERS_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(transfer_queue){
			amqp_connection.exchange(CHAT_TRANSFERS_EXCHANGE_NAME, {type: 'topic', durable: true}, function (transfer_exchange) {
				transfer_queue.unbind(transfer_exchange, current_user.nickname);
			});
		});

		socketUsers[socketConnections[socket.id]] = null;
		socketConnections[socket.id] = null;
	});
});

httpserver.listen(9090, '0.0.0.0');

function handler(request, response) {
	var path = url.parse(request.url).pathname;
	switch (path){
		case '/logout':
			socketUsers[request.session.id] = null;
			response.writeHead(200, {
				'Content-Type': 'text/html',
				'Set-Cookie': [
					request.session.getSetCookieHeaderValue(),
					cookie.serialize(REDIS_KEY, request.session.id, { path: '/', expires: new Date(0) })//TODO: and drop key from redis
				]
			});
			path = '/index.html';
		case '/':
		case '/index.html':
			var urlParams = url.parse(request.url, true).query || {};

			if(typeof urlParams.name != 'undefined'){
				//I don't know why, but it helps me in bug about multiple refreshes
				if(socketUsers[request.session.id]){
					request.session.id = request.session.id+' ';
				}
				socketUsers[request.session.id] = {nickname: urlParams.name, current_room: null, old_room: null};
				response.writeHead(200, {
					'Content-Type': 'text/html',
					'Set-Cookie': [
						request.session.getSetCookieHeaderValue(),
						cookie.serialize(REDIS_KEY, request.session.id, { path: '/' })
					]
				});
			}
			else
			{
				response.writeHead(200, {'Content-Type': 'text/html'});
			}

			fs.readFile(__dirname + '/index.html', function(err, data){
				if(err)
				{
					return send404(response);
				}
				response.write(data, 'utf8');
				return response.end();
			});
			break;
	}
}

function send404(response){
	if(!response.ended){
		response.writeHead(404);
		response.write('404');
		return response.end();
	}
}

