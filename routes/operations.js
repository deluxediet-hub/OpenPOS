'use strict';

/** Owner-facing local backup status/run/verify operations. */
module.exports=function register(app,{requireAuth,requireRole,backupOperations,bad}){
  app.get('/api/backups/status',requireAuth,requireRole('manager','admin'),(req,res)=>res.json(backupOperations.status()));
  app.post('/api/backups/run',requireAuth,requireRole('manager','admin'),async(req,res)=>{
    try{const output=await backupOperations.backup();res.json({ok:true,output,status:backupOperations.status()});}
    catch(e){bad(res,e.message,500);}
  });
  app.post('/api/backups/verify',requireAuth,requireRole('manager','admin'),async(req,res)=>{
    try{const output=await backupOperations.verify();res.json({ok:true,output,status:backupOperations.status()});}
    catch(e){bad(res,e.message,500);}
  });
};
