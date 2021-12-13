const {
  Client,
  MessageMedia,
  Buttons,
  List,
  Location
} = require("whatsapp-web.js");
const express = require("express");
const { body, validationResult } = require("express-validator");
const socketIO = require("socket.io");
const qrcode = require("qrcode");
const http = require("http");
const fs = require("fs");
const { phoneNumberFormatter } = require("./helpers/formatter");
const fileUpload = require("express-fileupload");
const axios = require("axios");
const mime = require("mime-types");
var config = require('./config');
console.log(config);
const TEMPLATE_URL = config.url;
const port = process.env.PORT || config.port;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

io.setMaxListeners(0);

app.use(express.static("public"));
app.use(express.json());
app.use(
  express.urlencoded({
    extended: true
  })
);
app.use(
  fileUpload({
    debug: true
  })
);

const SESSION_FILE_PATH = "./whatsapp-session.json";
let sessionCfg;
if (fs.existsSync(SESSION_FILE_PATH)) {
  sessionCfg = require(SESSION_FILE_PATH);
}

app.get("/", (req, res) => {
  res.sendFile("index.html", {
    root: __dirname
  });
});

const client = new Client({
  restartOnAuthFail: true,
  puppeteer: {
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process", // <- this one doesn't works in Windows
      "--disable-gpu"
    ]
  },
  session: sessionCfg
});
client.setMaxListeners(0);

client.on("message", async msg => {
  try {
    if (msg.type == "chat" || msg.type == "buttons_response" || msg.type == "list_response") {
      console.log(msg.body);
      const templateData = await getTemplateData(msg);
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

const getTemplateData = async function(msg) {
  const response = await axios.get(TEMPLATE_URL);

  return response.data;
};

client
  .initialize()
  .then(ss => {
    console.log("Success");})
  .catch(err => {
    console.log(err);
  });

// Socket IO
io.on("connection", function(socket) {
  socket.emit("message", "Connecting...");

  client.on("qr", qr => {
    console.log("QR RECEIVED", qr);
    qrcode.toDataURL(qr, (err, url) => {
      socket.emit("qr", url);
      socket.emit("message", "QR Code received, scan please!");
    });
  });

  client.on("ready", () => {
    socket.emit("ready", "Whatsapp is ready!");
    socket.emit("message", "Whatsapp is ready!");
  });

  client.on("authenticated", session => {
    socket.emit("authenticated", "Whatsapp is authenticated!");
    socket.emit("message", "Whatsapp is authenticated!");
    console.log("AUTHENTICATED", session);
    sessionCfg = session;
    fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session), function(err) {
      if (err) {
        console.error(err);
      }
    });
  });

  client.on("auth_failure", function(session) {
    socket.emit("message", "Auth failure, restarting...");
  });

  client.on("disconnected", reason => {
    socket.emit("message", "Whatsapp is disconnected!");
    fs.unlinkSync(SESSION_FILE_PATH, function(err) {
      if (err) return console.log(err);
      console.log("Session file deleted!");
    });
    client.destroy();
    client.initialize();
  });
});

const checkRegisteredNumber = async function(number) {
  const isRegistered = await client.isRegisteredUser(number);
  return isRegistered;
};

// Send message
app.post(
  "/send-message",
  [body("number").notEmpty(), body("message").notEmpty()],
  async (req, res) => {
try{
    console.log(req.body);
    if (!req.body.number || !req.body.message) {
      return res.status(200).json({
        status: false,
        message: "Invalid Input"
      });
    }
    const errors = validationResult(req).formatWith(({ msg }) => {
      return msg;
    });

    if (!errors.isEmpty()) {
      return res.status(422).json({
        status: false,
        message: errors.mapped()
      });
    }

    const number = phoneNumberFormatter(req.body.number + "");
    const message = req.body.message.replaceAll("\\n", "\n");
    console.log(message);

    const isRegisteredNumber = await checkRegisteredNumber(number);

    if (!isRegisteredNumber) {
      return res.status(200).json({
        status: false,
        message: "The number is not registered"
      });
    }

    client
      .sendMessage(number, message)
      .then(response => {
        res.status(200).json({
          status: true,
          response: response
        });
      })
      .catch(err => {
        res.status(200).json({
          status: false,
          response: err
        });
      });
}catch(e){
	console.log(e)
}
  }
);

// Send media
app.post("/send-media", async (req, res) => {
try{
  console.log(req.body);
  if (
    !req.body.number ||
    !req.body.caption ||
    !req.body.file ||
    !req.body.file
  ) {
    return res.status(200).json({
      status: false,
      message: "Invalid Input"
    });
  }

  const number = phoneNumberFormatter(req.body.number + "");
  const caption = req.body.caption;
  const fileUrl = req.body.file;
  const isAudio = req.body.audio;
  const isVideo = req.body.video;

  // const media = MessageMedia.fromFilePath('./image-example.png');
  // const file = req.files.file;
  // const media = new MessageMedia(file.mimetype, file.data.toString('base64'), file.name);
  let mimetype;
  const attachment = await axios
    .get(fileUrl, {
      responseType: "arraybuffer"
    })
    .then(response => {
      mimetype = response.headers["content-type"];
      return response.data.toString("base64");
    });

  const media = new MessageMedia(mimetype, attachment, "Media");

  client
    .sendMessage(number, media, {
      caption: caption,
      sendAudioAsVoice: isAudio,
      sendMediaAsDocument: isVideo
    })
    .then(response => {
      res.status(200).json({
        status: true,
        response: response
      });
    })
    .catch(err => {
      res.status(200).json({
        status: false,
        response: err
      });
    });
}catch(e){
	console.log(e)
}
});

const findGroupByName = async function(name) {
  const group = await client.getChats().then(chats => {
    return chats.find(
      chat => chat.isGroup && chat.name.toLowerCase() == name.toLowerCase()
    );
  });
  return group;
};

// Send message to group
// You can use chatID or group name, yea!
app.get("/status", async (req, res) => {
  return res.status(200).json({
    status: true
  });
});

// Send message to group
// You can use chatID or group name, yea!
app.post(
  "/send-group-message",
  [
    body("id").custom((value, { req }) => {
      if (!value && !req.body.name) {
        throw new Error("Invalid value, you can use `id` or `name`");
      }
      return true;
    }),
    body("message").notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req).formatWith(({ msg }) => {
      return msg;
    });

    if (!errors.isEmpty()) {
      return res.status(422).json({
        status: false,
        message: errors.mapped()
      });
    }

    let chatId = req.body.id;
    const groupName = req.body.name;
    const message = req.body.message;

    // Find the group by name
    if (!chatId) {
      const group = await findGroupByName(groupName);
      if (!group) {
        return res.status(422).json({
          status: false,
          message: "No group found with name: " + groupName
        });
      }
      chatId = group.id._serialized;
    }

    client
      .sendMessage(chatId, message)
      .then(response => {
        res.status(200).json({
          status: true,
          response: response
        });
      })
      .catch(err => {
        res.status(500).json({
          status: false,
          response: err
        });
      });
  }
);

// Clearing message on spesific chat
app.post("/clear-message", [body("number").notEmpty()], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => {
    return msg;
  });

  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.mapped()
    });
  }

  const number = phoneNumberFormatter(req.body.number);

  const isRegisteredNumber = await checkRegisteredNumber(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: "The number is not registered"
    });
  }

  const chat = await client.getChatById(number);

  chat
    .clearMessages()
    .then(status => {
      res.status(200).json({
        status: true,
        response: status
      });
    })
    .catch(err => {
      res.status(500).json({
        status: false,
        response: err
      });
    });
});

server.listen(port, function() {
  console.log("App running on *: " + port);
});
