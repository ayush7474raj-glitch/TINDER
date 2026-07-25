/* ===========================
   TINDER - app.js
   Part 1/4
=========================== */

const SECRET_CODE = "AYUSH123";
const MAX_MESSAGE = 1000;

let me = "";
let myKey = "";

let replyTarget = null;
let editingKey = null;

const msgCache = {};

const $ = (q) => document.querySelector(q);

const clean = (text) => {
    return (text || "").trim();
};

const safeKey = (text) => {
    return text.replace(/[.#$/[\]]/g, "_");
};

function toast(message){

    const t=$("#toast");

    if(!t) return;

    t.textContent=message;

    t.classList.remove("hidden");

    clearTimeout(window.toastTimer);

    window.toastTimer=setTimeout(()=>{
        t.classList.add("hidden");
    },2000);

}

function formatTime(time){

    if(!time) return "";

    return new Date(time).toLocaleTimeString([],{
        hour:"2-digit",
        minute:"2-digit"
    });

}
function applyTheme(theme){

    document.documentElement.dataset.theme=theme;

    localStorage.setItem("tinder_theme",theme);

    const btn=$("#themeToggle");

    if(btn){

        btn.textContent=
            theme==="dark"
            ?"🌙"
            :"☀️";

    }

    const meta=document.querySelector('meta[name="theme-color"]');

    if(meta){

        meta.setAttribute(
            "content",
            theme==="dark"
            ?"#0d0d12"
            :"#f4f5f9"
        );

    }

}

applyTheme(
localStorage.getItem("tinder_theme") || "dark"
);

const themeBtn=$("#themeToggle");

if(themeBtn){

themeBtn.onclick=()=>{

const next=
document.documentElement.dataset.theme==="dark"
?"light"
:"dark";

applyTheme(next);

};

}
const loginBtn=$("#loginBtn");

if(loginBtn){

loginBtn.onclick=login;

}

function login(){

const username=clean(
$("#loginUsername").value
);

const code=clean(
$("#loginCode").value
);

if(username===""){

toast("Enter username");

return;

}

if(code!==SECRET_CODE){

toast("Wrong Secret Code");

return;

}

me=username;

myKey=safeKey(username);

localStorage.setItem(
"tinder_user",
username
);

usersRef.child(myKey).update({

username:username,

online:true,

lastSeen:TIMESTAMP

});

usersRef.child(myKey)
.onDisconnect()
.update({

online:false,

lastSeen:TIMESTAMP

});

$("#loginScreen").classList.add("hidden");

$("#chatScreen").classList.remove("hidden");

listenMessages();

listenUsers();

}
/* ===========================
   PART 2/4
=========================== */

function listenUsers(){

    usersRef.on("value",(snap)=>{

        const users=snap.val()||{};

        let online=0;

        Object.values(users).forEach(user=>{

            if(user.online) online++;

        });

        const count=$("#onlineCount");

        if(count){

            count.textContent=online;

        }

    });

}


function listenMessages(){

    messagesRef
    .limitToLast(300)
    .on("child_added",(snap)=>{

        msgCache[snap.key]=snap.val();

        appendMessage(
            snap.key,
            snap.val()
        );

    });

}


function appendMessage(key,data){

    const box=$("#messages");

    if(!box) return;

    const msg=buildMessage(
        key,
        data
    );

    box.appendChild(msg);

    box.scrollTop=box.scrollHeight;

}


function buildMessage(key,data){

    const mine=data.sender===me;

    const wrap=document.createElement("div");

    wrap.className=
        "msg "+(mine?"me":"other");

    wrap.dataset.key=key;


    /* Username */

    const name=document.createElement("div");

    name.className="msg-name";

    name.textContent=
        data.sender || "Unknown";

    wrap.appendChild(name);


    /* Reply */

    if(data.replyTo){

        const quote=document.createElement("div");

        quote.className="msg-quote";

        quote.innerHTML=

        "<strong>"+data.replyTo.sender+
        "</strong><span>"+
        (data.replyTo.text||"")+
        "</span>";

        wrap.appendChild(quote);

    }


    /* Image */

    if(data.image){

        const img=document.createElement("img");

        img.className="msg-img";

        img.src=data.image;

        wrap.appendChild(img);

    }


    /* Text */

    if(data.text){

        const text=document.createElement("div");

        text.className="msg-text";

        text.textContent=data.text;

        wrap.appendChild(text);

    }


    /* Time */

    const meta=document.createElement("div");

    meta.className="msg-meta";

    meta.textContent=
        formatTime(data.timestamp);

    wrap.appendChild(meta);


    wrap.onclick=()=>{

        openSheet(key);

    };


    return wrap;

}
/* ===========================
   PART 3/4
=========================== */

const input = $("#messageInput");

if(input){

input.addEventListener("input",()=>{

const count=$("#charCount");

if(count){

count.textContent=
input.value.length+"/1000";

}

setTyping(
input.value.trim()!==""
);

});

input.addEventListener("keydown",(e)=>{

if(e.key==="Enter" && !e.shiftKey){

e.preventDefault();

sendMessage();

}

});

}

const sendBtn=$("#sendBtn");

if(sendBtn){

sendBtn.onclick=sendMessage;

}

function setTyping(active){

if(!myKey) return;

if(active){

typingRef.child(myKey).set(me);

clearTimeout(window.typingTimer);

window.typingTimer=setTimeout(()=>{

typingRef.child(myKey).remove();

},2000);

}else{

typingRef.child(myKey).remove();

}

}


function sendMessage(){

const text=clean(input.value);

if(text==="") return;

messagesRef.push({

sender:me,

text:text,

image:"",

timestamp:TIMESTAMP,

edited:false,

replyTo:replyTarget,

seenBy:{
[myKey]:true
}

});

input.value="";

$("#charCount").textContent="0/1000";

setTyping(false);

replyTarget=null;

const bar=$("#replyBar");

if(bar){

bar.classList.add("hidden");

}

}


/* IMAGE */

const imageInput=$("#imageInput");

const imageBtn=$("#imageBtn");

if(imageBtn){

imageBtn.onclick=()=>{

imageInput.click();

};

}

if(imageInput){

imageInput.onchange=(e)=>{

const file=e.target.files[0];

if(!file) return;

const reader=new FileReader();

reader.onload=()=>{

messagesRef.push({

sender:me,

text:"",

image:reader.result,

timestamp:TIMESTAMP,

edited:false,

replyTo:null,

seenBy:{
[myKey]:true
}

});

};

reader.readAsDataURL(file);

};

}
/* ===========================
   PART 4/4
=========================== */

/* ---------- Reply ---------- */

function cancelReply(){

replyTarget=null;

const bar=$("#replyBar");

if(bar){

bar.classList.add("hidden");

}

}

const replyCancel=$("#replyCancel");

if(replyCancel){

replyCancel.onclick=cancelReply;

}


/* ---------- Logout ---------- */

const logoutBtn=$("#logoutBtn");

if(logoutBtn){

logoutBtn.onclick=()=>{

if(!confirm("Logout from TINDER?")) return;

usersRef.child(myKey).update({

online:false,

lastSeen:TIMESTAMP

});

typingRef.child(myKey).remove();

localStorage.removeItem("tinder_user");

location.reload();

};

}


/* ---------- Search ---------- */

const searchInput=$("#searchInput");

if(searchInput){

searchInput.oninput=()=>{

const value=searchInput.value.toLowerCase();

document.querySelectorAll(".msg").forEach(msg=>{

const text=msg.innerText.toLowerCase();

msg.style.display=

text.includes(value)

?""

:"none";

});

};

}


/* ---------- Members ---------- */

const onlineBtn=$("#onlineBtn");

if(onlineBtn){

onlineBtn.onclick=()=>{

const modal=$("#membersModal");

if(modal){

modal.classList.remove("hidden");

}

};

}

const membersClose=$("#membersClose");

if(membersClose){

membersClose.onclick=()=>{

$("#membersModal").classList.add("hidden");

};

}


/* ---------- Settings ---------- */

const settingsBtn=$("#settingsBtn");

if(settingsBtn){

settingsBtn.onclick=()=>{

$("#settingsModal").classList.remove("hidden");

};

}

const settingsClose=$("#settingsClose");

if(settingsClose){

settingsClose.onclick=()=>{

$("#settingsModal").classList.add("hidden");

};

}


/* ---------- Save Settings ---------- */

const settingsSave=$("#settingsSave");

if(settingsSave){

settingsSave.onclick=()=>{

const name=clean(

$("#setUsername").value

);

if(name!==""){

me=name;

myKey=safeKey(name);

usersRef.child(myKey).update({

username:name,

online:true,

lastSeen:TIMESTAMP

});

localStorage.setItem(

"tinder_user",

name

);

}

$("#settingsModal").classList.add("hidden");

toast("Settings Saved");

};

}


/* ---------- Auto Login ---------- */

const savedUser=

localStorage.getItem(

"tinder_user"

);

if(savedUser){

$("#loginUsername").value=savedUser;

}


