// Shared Google client using Contract Engine's OAuth (jayme@jaymestone.com).
const fs=require("fs"), path=require("path");
const CE="/Users/jaymestone/Projects/contract-engine";
const { OAuth2Client } = require(CE+"/node_modules/google-auth-library");
const { sheets } = require(CE+"/node_modules/@googleapis/sheets");
const { drive } = require(CE+"/node_modules/@googleapis/drive");
const c=JSON.parse(fs.readFileSync(CE+"/secrets/google-oauth-client.json")); const k=c.installed||c.web;
const auth=new OAuth2Client(k.client_id,k.client_secret,(k.redirect_uris||[])[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(CE+"/secrets/google-oauth-tokens.json")));
module.exports={ sheets: sheets({version:"v4",auth}), drive: drive({version:"v3",auth}), MASTER:"1xcDRCQt0jsh2zq9UCO2ujltM8kVaFZ5rBJFQ3oty7Sc" };
