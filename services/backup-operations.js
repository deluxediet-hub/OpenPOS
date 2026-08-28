'use strict';
const fs=require('fs');
const path=require('path');
const {execFile}=require('child_process');

module.exports=function createBackupOperations({rootDir,dbPath}){
  const backupDir=process.env.POS_BACKUP_DIR||path.join(rootDir,'backups');
  const statusFile=path.join(backupDir,'backup-status.json');
  const run=(script)=>new Promise((resolve,reject)=>execFile(process.execPath,[path.join(rootDir,'scripts',script)],{
    cwd:rootDir,env:{...process.env,POS_DB:dbPath,POS_BACKUP_DIR:backupDir}
  },(error,stdout,stderr)=>error?reject(new Error((stderr||stdout||error.message).trim())):resolve((stdout||'').trim())));
  function status(){
    let saved=null;try{saved=JSON.parse(fs.readFileSync(statusFile,'utf8'));}catch{}
    const files=fs.existsSync(backupDir)?fs.readdirSync(backupDir).filter((x)=>/^pos-.*\.db$/.test(x)).map((x)=>{
      const file=path.join(backupDir,x),stat=fs.statSync(file);return{file,name:x,mtime:stat.mtime.toISOString(),size:stat.size};
    }).sort((a,b)=>b.mtime.localeCompare(a.mtime)):[];
    const latest=files[0]||null;
    return{directory:backupDir,last_status:saved,latest,stale:!latest||Date.now()-new Date(latest.mtime).getTime()>26*3600000,count:files.length};
  }
  return{status,backup:()=>run('backup.js'),verify:()=>run('verify-backup.js')};
};
