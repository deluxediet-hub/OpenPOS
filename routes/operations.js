'use strict';

/** Owner-facing local backup status/run/verify operations. */
module.exports=function register(app,{requireAuth,requireRole,backupOperations,audit,bad}){
  app.get('/api/backups/status',requireAuth,requireRole('manager','admin'),(req,res)=>res.json(backupOperations.status()));
  app.post('/api/backups/run',requireAuth,requireRole('manager','admin'),async(req,res)=>{
    try{const output=await backupOperations.backup();res.json({ok:true,output,status:backupOperations.status()});}
    catch(e){bad(res,e.message,500);}
  });
  app.post('/api/backups/verify',requireAuth,requireRole('manager','admin'),async(req,res)=>{
    try{const output=await backupOperations.verify();res.json({ok:true,output,status:backupOperations.status()});}
    catch(e){bad(res,e.message,500);}
  });
  app.post('/api/backups/restore',requireAuth,requireRole('admin'),(req,res)=>{
    if(String(req.body.confirm||'')!=='RESTORE')return bad(res,'Type RESTORE to confirm replacement of the live database');
    try{const result=backupOperations.scheduleRestore(String(req.body.name||''));
      audit(req.user,'backup.restore.schedule',result.name);res.status(202).json({...result,message:'Restore scheduled. OpenPOS will restart automatically.'});}
    catch(e){bad(res,e.message,400);}
  });
};
