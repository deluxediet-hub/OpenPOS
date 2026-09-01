'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.join(__dirname,'..');
const include=['server.js','db.js','lib','routes','services','public','scripts','package.json','package-lock.json'];
const files={};
function walk(rel){const full=path.join(root,rel),st=fs.statSync(full);if(st.isDirectory())for(const name of fs.readdirSync(full).sort())walk(path.join(rel,name));
  else files[rel.split(path.sep).join('/')]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}
for(const rel of include)walk(rel);
const pkg=require(path.join(root,'package.json'));
const manifest={product:'OpenPOS',version:pkg.version,generated_at:new Date().toISOString(),files};
fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const installer=path.join(root,'packaging','output','OpenPOS-Setup.exe');
if(fs.existsSync(installer)){
  const sum=crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  fs.writeFileSync(path.join(root,'packaging','output','SHA256SUMS.txt'),`${sum}  OpenPOS-Setup.exe\n`);
  console.log(`Installer SHA-256: ${sum}`);
}
console.log(`Release manifest ${pkg.version}: ${Object.keys(files).length} files`);
