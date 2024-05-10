const net = require('net');

const cfg = {
  port: 1337,
  wsPort: 2337, // comment out if you don't need websocket bridge
  buffer_size: 1024 * 16, // buffer allocated per each socket client
  sendOwnMessagesBack: true // if disabled, clients don't get their own messages back
  // verbose: true, // set to true to capture lots of debug info
};

const sockets = {}; // this is where we store all current client socket connections

let sendAsWsMessage;

let servers = [
    // id will be automatically generated, but for servers that stay, we can set it manually
    {
        name: "Big Lobby", // Average4k reference :scream:
        staysOpen: true, // Doesn't close when empty
        maxPlayers: 100,
        players: [],
        host: null,
        password: null,
        hasPassword: false,
        id: 0,
        currentSong: {
          songName: " Another Me",
          songDiff: " An Other Me"
        },
        started: false,
    }
]

if (cfg.wsPort) {
  function sendAsTcpMessage(payload, channel) {
    const channelSockets = sockets[channel];
    if (!channelSockets) {
      return;
    }
    const subscribers = Object.values(channelSockets);
    for (let sub of subscribers) {
      sub.isConnected && sub.write(payload);
    }
  }

  sendAsWsMessage = require('./ws-server')({
    port: cfg.wsPort,
    verbose: cfg.verbose,
    sendAsTcpMessage,
    sendOwnMessagesBack: cfg.sendOwnMessagesBack
  });
}

const server = net.createServer();

function _log() {
  if (cfg.verbose) console.log.apply(console, arguments);
}

// black magic
process.on('uncaughtException', (err) => {
  _log('Exception: ' + err); // TODO: think we should terminate it on such exception
});

server.on('connection', (socket) => {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 300 * 1000);
  socket.isConnected = true;
  socket.connectionId = socket.remoteAddress + '-' + socket.remotePort; // unique, used to trim out from sockets hashmap when closing socket
  socket.buffer = Buffer.alloc(cfg.buffer_size);
  socket.buffer.len = 0; // due to Buffer's nature we have to keep track of buffer contents ourself

  _log('New client: ' + socket.remoteAddress + ':' + socket.remotePort);

  socket.on('data', (dataRaw) => {
    // dataRaw is an instance of Buffer as well
    if (dataRaw.length > cfg.buffer_size - socket.buffer.len) {
      _log(
        "Message doesn't fit the buffer. Adjust the buffer size in configuration"
      );
      socket.buffer.len = 0; // trimming buffer
      return false;
    }

    socket.buffer.len += dataRaw.copy(socket.buffer, socket.buffer.len); // keeping track of how much data we have in buffer

    let start;
    let end;
    let str = socket.buffer.slice(0, socket.buffer.len).toString();

    // PROCESS SUBSCRIPTION 1ST
    if (
      (start = str.indexOf('__SUBSCRIBE__')) !== -1 &&
      (end = str.indexOf('__ENDSUBSCRIBE__')) !== -1
    ) {
      // if socket was on another channel delete the old reference
      if (
        socket.channel &&
        sockets[socket.channel] &&
        sockets[socket.channel][socket.connectionId]
      ) {
        delete sockets[socket.channel][socket.connectionId];
      }
      socket.channel = str.substr(start + 13, end - (start + 13));
      socket.write('Hello. Noobhub online. \r\n');
      _log(
        `TCP Client ${socket.connectionId} subscribes for channel: ${socket.channel}`
      );
      str = str.substr(end + 16); // cut the message and remove the precedant part of the buffer since it can't be processed
      socket.buffer.len = socket.buffer.write(str, 0);
      sockets[socket.channel] = sockets[socket.channel] || {}; // hashmap of sockets  subscribed to the same channel
      sockets[socket.channel][socket.connectionId] = socket;
    }

    let timeToExit = true;
    do {
      // this is for a case when several messages arrived in buffer
      // PROCESS JSON NEXT
      if (
        (start = str.indexOf('__JSON__START__')) !== -1 &&
        (end = str.indexOf('__JSON__END__')) !== -1
      ) {
        var json = str.substr(start + 15, end - (start + 15));
        _log(`TCP Client ${socket.connectionId} posts json: ${json}`);
        // if json action is "getServers" then send the servers array to the client
        // convert json str to object 
        var obj = JSON.parse(json);
        str = str.substr(end + 13); // cut the message and remove the precedant part of the buffer since it can't be processed
        socket.buffer.len = socket.buffer.write(str, 0);

        // ALWAYS return the user
        if (obj.action === "getServers") {
            console.log("Sending servers to client");
            json = `{"servers": ${JSON.stringify(servers)}, "action": "gotServers", "user": ${JSON.stringify(obj.user)}}`
        } else if (obj.action === "updateServerInfo_USERJOINED") {
            console.log("User joined server");
            // add user to server
            servers[obj.id].players.push(obj.user);
            console.log("SERVER ID: " + obj.id);

            json = `{"action": "updateServerInfo_USERJOINED", "id": ${obj.id}, "user": ${JSON.stringify(obj.user)}, "server": ${JSON.stringify(servers[obj.id])}}`
        } else if (obj.action === "updateServerInfo_USERLEFT") {
            console.log("User left server");

            // remove user from server
            // go into players array and find matching steamID
            // remove that player from the array
            var i = 0;
            while (i < servers[obj.id].players.length) {
                if (servers[obj.id].players[i].steamID === obj.user.steamID) {
                    servers[obj.id].players.splice(i, 1);
                    break;
                }
                i++;
            }

            console.log(servers[obj.id].players);

            if (servers[obj.id].players.length === 0) {
                servers[obj.id].started = false;
            }

            json = `{"action": "updateServerInfo_USERLEFT", "id": ${obj.id}, "server": ${JSON.stringify(servers[obj.id])}}`
        } else if (obj.action === "updateServerInfo_FORCEREMOVEUSER") {
            // goes into every server and removes the user from the players array
            console.log("Forcing user to leave server");
            for (var i = 0; i < servers.length; i++) {
                var j = 0;
                while (j < servers[i].players.length) {
                    if (servers[i].players[j].steamID === obj.user.steamID) {
                        servers[i].players.splice(j, 1);
                        break;
                    }
                    j++;
                }
            }

            for (var i = 0; i < servers.length; i++) {
                if (servers[i].players.length === 0) {
                    servers[i].started = false;
                }
            }
            json = `{"action": "updateServerInfo_FORCEREMOVEUSER", "user": ${JSON.stringify(obj.user)}, "servers": ${JSON.stringify(servers)}}`
        } else if (obj.action === "getPlayersInfo_INGAME") {
            // Also updates the currents player info
            //console.log("Getting players info for in game");
            // get the server
            var server = servers[obj.id];
            
            // update the player
            for (var i = 0; i < server.players.length; i++) {
                if (server.players[i].steamID === obj.user.steamID) {
                    server.players[i] = obj.user;
                    break;
                }
            }
            //console.log(server.players);

            // update servers player
            servers[obj.id] = server;

            json = `{"action": "getPlayersInfo_INGAME", "id": ${obj.id}, "user": ${JSON.stringify(obj.user)}, "server": ${JSON.stringify(server)}}`
        } else if (obj.action === "startGame") {
          console.log("Starting game");
          json = `{"action": "startGame", "id": ${obj.id}, "server": ${JSON.stringify(servers[obj.id])}}`
          //console.log(json);
        } else if (obj.action === "resultScreen_NEWENTRY") {
          /*
          action = "resultScreen_NEWENTRY",
                id = love.timer.getTime(),
                user = {
                    steamID = tostring(SteamID),
                    name = tostring(SteamUserName),
                    score = results.score,
                    accuracy = results.accuracy,
                    completed = true
                }
                */
          console.log(obj.id);
          var server = servers[obj.id];
          
          // replace the user in the server
          for (var i = 0; i < server.players.length; i++) {
            if (server.players[i].steamID === obj.user.steamID) {
              server.players[i] = obj.user;
              break;
            }
          }

          json = `{"action": "resultScreen_NEWENTRY", "id": ${obj.id}, "user": ${JSON.stringify(obj.user)}, "server": ${JSON.stringify(server)}}`
        } else if (obj.action === "updateServerInfo_INGAME_STARTEND") {
          // find server from obj.id
          var server = servers[obj.id];
          server.started = obj.started;
          servers[obj.id] = server;
          json = `{"action": "updateServerInfo_INGAME_STARTEND", "id": ${obj.id}, "started": ${obj.started}, "server": ${JSON.stringify(server)}}`
        }
        //console.log(json);

        const payload = '__JSON__START__' + json + '__JSON__END__';

        sendAsWsMessage && sendAsWsMessage(payload, socket.channel);

        const channelSockets = sockets[socket.channel];
        if (channelSockets) {
          const subscribers = Object.values(channelSockets);
          for (let sub of subscribers) {
            if (!cfg.sendOwnMessagesBack && sub === socket) {
              continue;
            }
            sub.isConnected && sub.write(payload);
          }
        }
        timeToExit = false;
      } else {
        timeToExit = true;
      } // if no json data found in buffer - then it is time to exit this loop
    } while (!timeToExit);
  }); // end of  socket.on 'data'

  socket.on('error', () => {
    return _destroySocket(socket);
  });
  socket.on('close', () => {
    return _destroySocket(socket);
  });
}); //  end of server.on 'connection'

function _destroySocket(socket) {
  if (
    !socket.channel ||
    !sockets[socket.channel] ||
    !sockets[socket.channel][socket.connectionId]
  )
    return;
  sockets[socket.channel][socket.connectionId].isConnected = false;
  sockets[socket.channel][socket.connectionId].destroy();
  sockets[socket.channel][socket.connectionId].buffer = null;
  delete sockets[socket.channel][socket.connectionId].buffer;
  delete sockets[socket.channel][socket.connectionId];
  _log(
    `${socket.connectionId} has been disconnected from channel ${socket.channel}`
  );

  if (Object.keys(sockets[socket.channel]).length === 0) {
    delete sockets[socket.channel];
    _log('empty channel wasted');
  }
}

server.on('listening', () => {
  console.log(
    `NoobHub on ${server.address().address}:${server.address().port}`
  );
});

// looping function (every 60 seconds) to check if servers are empty and if they are, close them
setInterval(() => {
  console.log("Checking servers");
  for (var i = 0; i < servers.length; i++) {
    if (servers[i].players.length === 0 && servers[i].staysOpen === false) {
      servers.splice(i, 1);
    }
  }
}, 60000);

server.listen(cfg.port, '::');