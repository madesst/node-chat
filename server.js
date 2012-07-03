var http = require('http');
var url = require('url');
var fs = require('fs');
var io = require('socket.io');

var session = require('sesh/lib/core').magicSession();
var cookie = require('cookie');
var amqp = require('amqp');

var httpserver = http.createServer(handler);
var socketioserver = io.listen(httpserver).set('log level', 2);

var REDIS_KEY = 'redis_key';
var CHAT_PUBLIC_EXCHANGE_NAME = 'chat.public.exchange';
var CHAT_PRIVATE_EXCHANGE_NAME = 'chat.private.exchange';
var CHAT_TRANSFERS_EXCHANGE_NAME = 'chat.transfers.exchange';
var CHAT_PUBLIC_QUEUE_NAME = 'chat.public';
var CHAT_PRIVATE_QUEUE_NAME = 'chat.private';
var CHAT_TRANSFERS_QUEUE_NAME = 'chat.transfers';
var CHAT_AMQP_QUEUE_CONFIG = {durable: true, autoDelete: true};
var CHAT_AMQP_CONNECTION_CONFIG = { host: 'localhost', login: 'guest', password: 'guest' };
var CHAT_DEFAULT_USER = {nickname: 'Guest', current_room: 'someroom'};

var socketUsers = [];//my redis :)
var socketConnections = [];

socketioserver.sockets.on('connection', function(socket) {
	var public_exchange, private_exchange, transfer_exchage, current_user, amqp_connection;

	socket.on('link_socket', function(data) {
		socketConnections[socket.id] = cookie.parse(data)[REDIS_KEY];
		current_user = socketUsers[socketConnections[socket.id]] ? socketUsers[socketConnections[socket.id]] : CHAT_DEFAULT_USER;


		amqp_connection = amqp.createConnection(CHAT_AMQP_CONNECTION_CONFIG);
		amqp_connection.on('ready', function () {
			amqp_connection.queue(CHAT_PUBLIC_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(q){
				amqp_connection.exchange(CHAT_PUBLIC_EXCHANGE_NAME, {type: 'topic', durable: true}, function (exchange) {
					public_exchange = exchange;
					q.bind(exchange, current_user.current_room + '.#');
					q.subscribe(function (message, headers, deliveryInfo) {
						socket.send(JSON.stringify({
							message: message.message,
							type: 'public',
							from: message.from,
							to: message.to
						}));
					});
				});
			});

			amqp_connection.queue(CHAT_TRANSFERS_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(q){
				amqp_connection.exchange(CHAT_TRANSFERS_EXCHANGE_NAME, {type: 'topic', durable: true}, function (exchange) {
					transfer_exchage = exchange;
					q.bind(exchange, current_user.current_room + '.#');
					q.subscribe(function (message, headers, deliveryInfo) {
						//TODO: rebind public queue
						console.log(message);
//						socket.send(JSON.stringify({
//							message: message.message,
//							type: 'public',
//							from: message.from,
//							to: message.to
//						}));
					});
				});
			});

			amqp_connection.queue(CHAT_PRIVATE_QUEUE_NAME + '.'+ current_user.nickname + '.' + socket.id, CHAT_AMQP_QUEUE_CONFIG, function(q){
				amqp_connection.exchange(CHAT_PRIVATE_EXCHANGE_NAME, {type: 'topic', durable: true}, function (exchange) {
					private_exchange = exchange;
					q.bind(private_exchange, '#.'+current_user.nickname+'.#');
					q.subscribe(function (message, headers, deliveryInfo) {
						socket.send(JSON.stringify({
							message: message.message,
							type: 'private',
							from: message.from,
							to: message.to
						}));
					});
				});

				socket.emit('set_current_user', JSON.stringify({
					nickname: current_user.nickname
				}));
			});
		});
	});

	socket.on('message', function(data) {
		var msg = JSON.parse(data);
		if(message == 'undefined'){
			return false;
		}

		current_user = socketUsers[socketConnections[socket.id]] ? socketUsers[socketConnections[socket.id]] : CHAT_DEFAULT_USER;

		var recipients = '';
		var message = msg.message;
		var exchanger = public_exchange;
		var routing_key = current_user.current_room+'.'+current_user.nickname;

		var type_private_check = message.match(/private\s\[(.*)\]\s(.*)/);
		if(type_private_check){//Private message
			recipients = type_private_check[1]; message = type_private_check[2];
			routing_key = current_user.nickname+'.'+recipients;
			exchanger = private_exchange;
		} else{//Public message
			var type_to_check = message.match(/to\s\[(.*)\]\s(.*)/);
			if(type_to_check) { recipients = type_to_check[1]; message = type_to_check[2]; }
		}

		exchanger.publish(routing_key, {message: message, from: current_user.nickname, to: recipients}, {contentType: 'application/json'});
	});

	socket.on('transfer', function(data) {
		var transfer_info = JSON.parse(data);
		console.log(transfer_info);
		current_user = socketUsers[socketConnections[socket.id]] ? socketUsers[socketConnections[socket.id]] : CHAT_DEFAULT_USER;
		transfer_exchage.publish(current_user.current_room + '.#', {from: current_user.nickname, to: transfer_info.chat_room});
	});

	socket.on('disconnect', function() {
		//TODO: drop key from redis
//		socketUsers[socketConnections[socket.id]] = null;
//		socketConnections[socket.id] = null;
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
				socketUsers[request.session.id] = {nickname: urlParams.name, current_room: 'someroom'};
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

