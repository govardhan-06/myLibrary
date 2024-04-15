import express from "express";
import bodyParser from "body-parser";
import { dirname } from "path";
import { fileURLToPath } from "url";
import env from "dotenv";
import pg from "pg";
import bcrypt from "bcrypt";
import passport from "passport";
import { Strategy } from "passport-local";
import GoogleStrategy from "passport-google-oauth2";
import session from "express-session";
import { GoogleGenerativeAI } from "@google/generative-ai";
env.config();

const app=express();
const port=3000;
const saltRounds = 10;
const __dirname=dirname(fileURLToPath(import.meta.url));

app.use("/public",express.static(__dirname+"/public"));
app.use(bodyParser.urlencoded({extended:true}));

//Authentication
//Cookies-Sessions
app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: true,
    })
);

app.use(passport.initialize());
app.use(passport.session());

//BookChat
const genAI = new GoogleGenerativeAI(process.env.API_KEY_GOOGLE); //API KEY
const model = genAI.getGenerativeModel({ model: "gemini-pro"});

//Database
const db=new pg.Client({
    user:process.env.DB,
    password:process.env.DB_PASSWORD,
    host:process.env.DB_HOSTNAME,
    database:process.env.DB_NAME,
    port:process.env.DB_PORT
  });
db.connect();

var current_userid="";
var book_data={};
var user_data={};
var modelResponse={};

//Authentication
//Sign-up
app.get("/",(req,res)=>{
    res.render(__dirname+"/signup.ejs");
});
app.post("/signup", async (req, res) => {
    const fname=req.body.fname;
    const lname=req.body.lname;
    const email = req.body.email;
    const password = req.body.password;
    try {
      const checkResult = await db.query("SELECT * FROM users WHERE email = $1", [
        email,
      ]);
      if (checkResult.rows.length > 0) {
        res.redirect("/sign-in");
      } else {
        bcrypt.hash(password, saltRounds, async (err, hash) => {
          if (err) {
            console.error("Error hashing password:", err);
          } else {
            const result = await db.query(
              "INSERT INTO users (fname,lname,password,email) VALUES ($1,$2,$3,$4) RETURNING *",
              [fname,lname,hash,email]
            );
            const user = result.rows[0];
            req.login(user, async (err) => {
              current_userid=parseInt(req.user.userid);
              res.redirect("/home");
            });
          }
        });
      }
    } catch (err) {
      console.log(err);
    }
  });

//Sign-in
app.get("/sign-in",(req,res)=>{
    res.render(__dirname+"/signin.ejs");
});

app.post(
    "/sign-in",
    passport.authenticate("local", {
      successRedirect: "/home",
      failureRedirect: "/",
    })
);
app.post("/signout", (req, res) => {
  req.logout(function (err) {
    if (err) {
    return next(err);
  }
  res.redirect("/");
});
});

//Home page
app.get("/home", async(req,res)=>{
    if(req.isAuthenticated()){
      user_data=await db.query("SELECT * FROM users WHERE userid=$1",[current_userid]);
      user_data=user_data.rows[0];
      book_data=await db.query("SELECT * FROM books WHERE userid=$1",[current_userid]);
      book_data=book_data.rows;
      res.render(__dirname+"/home.ejs",{user_data,book_data});
    }else{
      res.redirect("/sign-in");
    }
    
});
app.post("/editBookSelection", async(req,res)=>{
  if(req.isAuthenticated()){
    book_data=await db.query("SELECT * FROM books WHERE userid=$1 AND isbn=$2",[current_userid,req.body.ISBN]);
    book_data=book_data.rows;
    //date splitting
    // Step 1: Parse the Date String
    const date = new Date(book_data[0].readdate);
    // Step 2: Format the Date
    const formattedDate = date.toISOString().split('T')[0];
    const date_list=(formattedDate).split('-');
    book_data["year"]=Number(date_list[0]);
    book_data["month"]=Number(date_list[1]);
    book_data["day"]=Number(date_list[2]);
    res.render(__dirname+"/edit_book_details.ejs",{book_data});
  }else{
    res.redirect("/sign-in");
  }
    
});
app.post("/viewBookSelection",async (req,res)=>{
  if(req.isAuthenticated()){
    book_data=await db.query("SELECT * FROM books WHERE userid=$1 AND isbn=$2",[current_userid,req.body.ISBN]);
    book_data=book_data.rows;
    //date splitting
    // Step 1: Parse the Date String
    const date = new Date(book_data[0].readdate);
    // Step 2: Format the Date
    const formattedDate = date.toISOString().split('T')[0];
    book_data[0].readdate=formattedDate;
    res.render(__dirname+"/view_book_details.ejs",{book_data});
  }else{
    res.redirect("/sign-in");
  }
});
app.post("/deleteBookSelection",async (req,res)=>{
  if(req.isAuthenticated()){
  book_data=await db.query("SELECT bname,author,isbn FROM books WHERE userid=$1 AND isbn=$2",[current_userid,req.body.ISBN]);
  book_data=book_data.rows[0];
  console.log(book_data);
  res.render(__dirname+"/delete_book_details.ejs",{book_data});
  }else{
    res.redirect("/sign-in");
  }
});

app.get("/viewBookSelection",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/view_book_details.ejs",{user_data,book_data});
  }else{
    res.redirect("/sign-in");
  }
});

//Add Book_details
app.get("/add_book_details",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/add_book_details.ejs");
  }else{
    res.redirect("/sign-in");
  }
});

var notes="";
async function run_summariser(notes) {
    // For text-only input, use the gemini-pro model
    const model = genAI.getGenerativeModel({ model: "gemini-pro"});
  
    const prompt = `Summarise the text: `+notes;
  
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return text;
  }

var c=1;
var ops_message;
//variables to decide which type of message need to be displayed to the user (add,edit,delete operations)

app.post("/addBook",async(req,res)=>{
  if(req.isAuthenticated()){
    // Correcting the date format for database insertion
    let month = String(req.body.month);
    let day = String(req.body.day);
    let year = String(req.body.year);
    
    // Adding leading zeros if necessary
    month = month.padStart(2, '0');
    day = day.padStart(2, '0');
    
    let dateOfRead = `${year}-${month}-${day}`;

    const{bname,author,isbn,rating,notes}=req.body;
    var aigentext="";
    try{
        //getting the response from the function run_summariser()
        aigentext = await run_summariser(notes);
    }catch(error){
        console.log(error);
    }
    
    try {
        await db.query("INSERT INTO books(userid,isbn,bname,author,rating,aigentext,notes,readdate) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[current_userid,isbn,bname,author,rating,aigentext,notes,dateOfRead]);
        c=1;
    }catch (error) {
        console.error(error);
        c=0;
    }
    ops_message=(c===1)?true:false;
    res.render(__dirname+"/message.ejs",{ops:ops_message});
  }else{
    res.redirect("/sign-in");
  }
});

//Edit Book_details
app.get("/edit_book_details",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/edit_book_details.ejs",{book_data});   //already entered book data getting loaded to forms for edit
  }else{
    res.redirect("/sign-in");
  }
});

app.post("/editBook",async (req,res)=>{
  if(req.isAuthenticated()){
    const date=req.body.year+"-"+req.body.month+"-"+req.body.day;
    var aigentext='';
    try{
      //getting the response from the function run_summariser()
      aigentext = await run_summariser(req.body.notes);
    }catch(error){
      console.log(error);
    }
    console.log(`UPDATE books SET bname=${req.body.bname}, author=${req.body.author}, rating=${req.body.rating}, aigentext=${req.body.aigentext}, notes=${req.body.notes}, readdate=${date} WHERE userid=${current_userid} AND isbn=${req.body.isbn}`);

    await db.query("UPDATE books SET bname=$1, author=$2, rating=$3, aigentext=$4, notes=$5, readdate=$6 WHERE userid=$7 AND isbn=$8",[req.body.bname,req.body.author,req.body.rating,aigentext,req.body.notes,date,current_userid,req.body.isbn],async (err)=>{
      if(err){
        console.log("Edit failed");
        c=0;
      }else{
        c=1;
      }
      ops_message=(c===1)?true:false;
      res.render(__dirname+"/message.ejs",{ops:ops_message});
  });
  }else{
    res.redirect("/sign-in");
  }
});

//Delete Book_details
app.get("/delete_book_details",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/delete_book_details.ejs",{book_data});  
  }else{
    res.redirect("/sign-in");
  }
});
app.post("/deleteBook",async (req,res)=>{
  if(req.isAuthenticated()){
    await db.query("DELETE FROM books WHERE userid=$1 AND isbn=$2",[current_userid,req.body.isbn], async (err)=>{
    if(err){
      console.log("Deletion failed");
      c=0;
    }else{
      c=1;
    }
    ops_message=(c===1)?true:false;
    res.render(__dirname+"/message.ejs",{ops:ops_message});
  });
  }else{
    res.redirect("/sign-in");
  }
});

//BookChat
var user_prompt="";
var chat_history=[];
var modelResponse="";
async function run(user_prompt) {
    const chat = model.startChat({
      history: chat_history,
      generationConfig: {
        maxOutputTokens: 500,
      },
});
  
    const msg = user_prompt;
  
    const result = await chat.sendMessage(msg);
    const response = await result.response;
    const text = response.text();
    chat_history.push({role:"user",parts:[{text:msg}],});
    chat_history.push({role:"model",parts:[{text:text}],});
    //for resolving the issues while returning a value from asynchronous function
    return await new Promise((resolve) => {
        setTimeout(() => {
          resolve(text);
        }, 1000);
    });
}

app.get("/bookchat",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/bookchat.ejs",{user_data,modelResponse});
  }else{
    res.redirect("/sign-in");
  }
});
app.post("/geminiChat",async(req,res)=>{
  if(req.isAuthenticated()){
    try{
        user_prompt=req.body.user;
        //getting the response from the function run()
        modelResponse = await run(user_prompt);
        res.render(__dirname+"/bookchat.ejs",{user_data,modelResponse});
    }catch(error){
        console.log(error);
        res.redirect("/bookchat");
    }
  }else{
    res.redirect("/sign-in");
  }
});

//About page
app.get("/about",(req,res)=>{
  if(req.isAuthenticated()){
    res.render(__dirname+"/about.ejs",{user_data});
  }else{
    res.redirect("/sign-in");
  }
});

passport.use(
    "local",
    new Strategy(async function verify(username, password, cb) {
      try {
        const result = await db.query("SELECT * FROM users WHERE email = $1 ", [
          username,
        ]);
        if (result.rows.length > 0) {
          const user = result.rows[0];
          const storedHashedPassword = user.password;
          bcrypt.compare(password, storedHashedPassword, (err, valid) => {
            if (err) {
              console.error("Error comparing passwords:", err);
              return cb(err);
            } else {
              if (valid) {
                current_userid=user.userid;
                return cb(null, user);
              } else {
                return cb(null, false);
              }
            }
          });
        } else {
          return cb(null,false);
        }
      } catch (err) {
        console.log(err);
        return cb(err);
      }
    })
  );
  passport.serializeUser((user, cb) => {
    cb(null, user);
  });
  
  passport.deserializeUser((user, cb) => {
    cb(null, user);
  });
  
//Port
app.listen(port,()=>{
    console.log(`Server running on port ${port}`);
});
