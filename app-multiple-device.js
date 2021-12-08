const { Client,
  MessageMedia,
  Buttons,
  List,
  Location } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const axios = require('axios');
const port = process.env.PORT || 8000;
const BASE_URL = "https://nazal.in/w-bot/";

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-device.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = async function(sessions) {
  console.log("sessions")
  console.log(sessions);
  await makePostRequest(BASE_URL + "updateSession.php", sessions);
/*
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });*/
}
 
const getSessionsFile = async function() {  
  return await makeGetRequest(BASE_URL + "getSession.php");
  //return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}


const makeGetRequest = async function(url) {
  const response = await axios.get(url);

  console.log(url)
  console.log(response.data)
  return response.data;
}

const makePostRequest = async function(url, data) {
  console.log("Request data")
  console.log(data)
  const response = await axios.post(url, data);

  console.log("Response data")
  console.log(url)
  console.log(response.data)

  return response.data;
}

const createSession = async function(id, templateUrl) {
  console.log('Creating session: ' + id + ' ' + templateUrl);
  let sessionCfg;
  const res = await makeGetRequest(BASE_URL + "getClientDetails.php?id=" + id);
  console.log(res)
  if(res.WABrowserId != null){
    sessionCfg = res;
  }
  
  /*const SESSION_FILE_PATH = `./whatsapp-session-${id}.json`;
  
  if (fs.existsSync(SESSION_FILE_PATH)) {
    sessionCfg = require(SESSION_FILE_PATH);
  }*/

  const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    session: sessionCfg
  });

  client.initialize().catch( err=>{
    console.log(err)
  });

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
    });
  });

  client.on('ready', async () => {
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    const savedSessions = await getSessionsFile();
    console.log("savedSessions")
    console.log(savedSessions)
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', async (session) => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
    sessionCfg = session;
    var requsest = {
      id : id,
      data : session
    }
    await makePostRequest(BASE_URL + "saveClientDetails.php", requsest);
  });

  client.on("message", async msg => {
    try {
      console.log(msg.type);
      if (msg.type == "chat" || msg.type == "buttons_response" || msg.type == "list_response") {
        console.log(msg.body);
        const savedSessions = await getSessionsFile();
        console.log(savedSessions);
        const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
        console.log(sessionIndex);
        console.log(savedSessions[0]['templateUrl']);
        const templateData = await getTemplateData(savedSessions[0]['templateUrl']);
        var templateDataItem = templateData.filter(templateItem => {
          return (
            templateItem.conditionValue.toUpperCase() ===
            msg.body.trim().toUpperCase()
          );
        });
  
        if (templateDataItem.length == 0) {
          templateDataItem = templateData.filter(templateItem => {
            return templateItem.conditionValue.toUpperCase() === "***";
          });
        }
  
        console.log(msg.body + " : " + templateDataItem.length);
        if (templateDataItem.length > 0) {
          for (var j = 0; j < templateDataItem.length; j++) {
            if (templateDataItem[j].type === "Text") {
              client.sendMessage(msg.from, templateDataItem[j].message);
            } else if (templateDataItem[j].type === "Button") {
              var message = templateDataItem[j].message;
              var buttons = message.buttons.map(button => {
                return { body: button };
              });
              let button = new Buttons(
                message.body,
                buttons,
                message.title,
                message.footer
              );
              client.sendMessage(msg.from, button);
            } else if (templateDataItem[j].type === "List") {
              var message = templateDataItem[j].message;
              let sections = message.section.map(sec => {
                return { title: sec.title, rows: sec.rows };
              });
              let list = new List(
                message.body,
                message.btnText,
                sections,
                message.title,
                message.footer
              );
              client.sendMessage(msg.from, list);
            } else if (templateDataItem[j].type === "Location") {
              var message = templateDataItem[j].message;
              var location = new Location(
                message.lat,
                message.long,
                message.title
              );
              client.sendMessage(msg.from, location);
            } else if (templateDataItem[j].type === "File") {
              var message = templateDataItem[j].message;
              for (var i = 0; i < message.length; i++) {
                let mimetype;
                const attachment = await axios
                  .get(message[i].fileUrl, {
                    responseType: "arraybuffer"
                  })
                  .then(response => {
                    mimetype = response.headers["content-type"];
                    return response.data.toString("base64");
                  });
  
                let isVideo = mimetype.indexOf("video") >= 0;
                console.log(mimetype);
                console.log(attachment);
                console.log(message[i].caption);
  
                const media = new MessageMedia(
                  mimetype,
                  attachment,
                  message[i].caption
                );
  
                client.sendMessage(msg.from, media, {
                  caption: message[i].caption,
                  sendMediaAsDocument: isVideo
                });
              }
            } else if (templateDataItem[j].type === "Audio") {
              var message = templateDataItem[j].message;
              for (var i = 0; i < message.length; i++) {
                let mimetype;
                const attachment = await axios
                  .get(message[i].fileUrl, {
                    responseType: "arraybuffer"
                  })
                  .then(response => {
                    mimetype = response.headers["content-type"];
                    return response.data.toString("base64");
                  });
  
                const media = new MessageMedia(mimetype, attachment, "Media");
  
                client.sendMessage(msg.from, media, {
                  caption: message[i].caption,
                  sendAudioAsVoice: true
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.log("Exception Occured");
      console.log(err);
    }
  });

  client.on('auth_failure', function(session) {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });

  client.on('disconnected', (reason) => {
    io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
    fs.unlinkSync(SESSION_FILE_PATH, function(err) {
        if(err) return console.log(err);
        console.log('Session file deleted!');
    });
    client.destroy();
    client.initialize();

    // Menghapus pada file sessions
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions.splice(sessionIndex, 1);
    setSessionsFile(savedSessions);

    io.emit('remove-session', id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    templateUrl: templateUrl,
    client: client
  });

  // Menambahkan session ke file
  console.log("Here 1")
  const savedSessions = await getSessionsFile();
  console.log("Here 2")
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      templateUrl: templateUrl,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

  
const getTemplateData = async function(url) {
  const response = await axios.get(url);

  return response.data;
};

const init = async function(socket) {
  const savedSessions = await getSessionsFile();
  console.log("init starts")
  if (savedSessions.length > 0) {
    if (socket) {
      console.log("Yes Socket")
      socket.emit('init', savedSessions);
    } else {
      console.log("No Socket")
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.templateUrl);
      });
    }
  }
  console.log("init ends")
}

init();

// Socket IO
io.on('connection', function(socket) {
  init(socket);

  socket.on('create-session', function(data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.templateUrl);
  });
});


// Send message
app.post('/send-message', (req, res) => {
  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;
  console.log(req.body)
  const client = sessions.find(sess => sess.id == sender).client;
  console.log(client)
  
  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
