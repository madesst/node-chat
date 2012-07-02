var http = require('http');
var url = require('url');
var fs = require('fs');
var io = require('socket.io');
var session = require('sesh/lib/core').magicSession();
var cookie = require('cookie');

var context = require('rabbit.js').createContext('amqp://localhost:5672');

var httpserver = http.createServer(handler);
var socketioserver = io.listen(httpserver);

var SID_STRING = 'redis_key';
var TIMEOUT = 3*60*1000;

var socketUsers = [];//my redis :)
var socketConnections = [];

socketioserver.sockets.on('connection', function(connection) {

	var public_pub = context.socket('PUB');
	var public_sub = context.socket('SUB');
	var private_sub = context.socket('SUB');

	connection.on('link_socket', function(data) {
		socketConnections[connection.id] = cookie.parse(data)[SID_STRING];
		//some redis workaround
		var current_user = socketUsers[socketConnections[connection.id]] ? socketUsers[socketConnections[connection.id]] : 'Guest';

		connection.emit('set_current_user', JSON.stringify({
			nickname: current_user
		}));

		public_sub.connect('chat');public_sub.setEncoding('utf8');
		private_sub.connect('chat.'+current_user);private_sub.setEncoding('utf8');
		public_pub.connect('chat');

		public_sub.on('data', function(msg) {
			msg = JSON.parse(msg);
			connection.send(JSON.stringify({
				message: msg.message,
				type: 'public',
				from: msg.from,
				to: msg.to
			}));
		});

		private_sub.on('data', function(msg) {
			msg = JSON.parse(msg);
			connection.send(JSON.stringify({
				message: msg.message,
				type: 'private',
				from: msg.from,
				to: msg.to
			}));
		});

		return current_user;
	});

	connection.on('message', function(msg) {
		msg = JSON.parse(msg);
		if(msg.message == 'undefined')
		{
			return false;
		}

		//some redis workaround
		var current_user = socketUsers[socketConnections[connection.id]] ? socketUsers[socketConnections[connection.id]] : 'Guest';

		var type_private_check = msg.message.match(/private\s\[(.*)\]\s(.*)/);
		if(type_private_check)
		{
			var recipients = type_private_check[1];
			message = type_private_check[2];

			var my_private_pub = context.socket('PUB');
			my_private_pub.connect('chat.'+current_user, function(){
				my_private_pub.write(JSON.stringify({message: message, from: current_user, to: recipients}));
				my_private_pub.destroy();
			});

			var recipient_private_pub = context.socket('PUB');
			recipient_private_pub.connect('chat.'+recipients, function(){
				recipient_private_pub.write(JSON.stringify({message: message, from: current_user, to: recipients}));
				recipient_private_pub.destroy();
			});
		}
		else //Public message
		{
			var recipients = '';
			var message = msg.message;
			var type_to_check = message.match(/to\s\[(.*)\]\s(.*)/);
			if(type_to_check)
			{
				recipients = type_to_check[1];
				message = type_to_check[2];
			}

			public_pub.write({message: message, from: current_user, to: recipients});
		}
	});

	connection.on('disconnect', function() {
		public_pub.destroy();
		public_sub.destroy();
		private_sub.destroy();
	});
});

httpserver.listen(9090, '0.0.0.0');

// ==== boring detail

function handler(request, response) {
	var path = url.parse(request.url).pathname;
	switch (path){
		case '/':
			socketUsers[request.session.id] = null;
			response.writeHead(200, {
				'Content-Type': 'text/html',
				'Set-Cookie': [
					request.session.getSetCookieHeaderValue(),
					cookie.serialize(SID_STRING, request.session.id, { path: '/', expires: new Date(0) })
				]
			});
			path = '/index.html';
		case '/index.html':
			var urlParams = url.parse(request.url, true).query || {};

			if(typeof urlParams.name != 'undefined'){
				request.session.data.user = urlParams.name;
				socketUsers[request.session.id] = request.session.data.user;
				response.writeHead(200, {
					'Content-Type': 'text/html',
					'Set-Cookie': [
						request.session.getSetCookieHeaderValue(),
						cookie.serialize(SID_STRING, request.session.id, { path: '/' })
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
	if(!response.ended)
	{
		response.writeHead(404);
		response.write('404');
		return response.end();
	}
}

