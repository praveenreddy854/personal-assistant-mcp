import { cp,mkdir,rm,copyFile,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
function run(command,args,cwd=process.cwd()) {
  const result=spawnSync(command,args,{cwd,stdio:'inherit',env:{...process.env,npm_config_cache:process.env.npm_config_cache??join(tmpdir(),'personal-memory-npm-cache')}});
  if(result.status!==0)throw new Error(`${command} failed (${result.status})`);
}
if(!process.argv.includes('--skip-build'))run('npm',['run','build']);
const root=resolve('artifacts'),stage=resolve(root,'azure'),archive=resolve(root,'personal-memory-azure.zip');
await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
for(const file of ['package.json','package-lock.json','host.json'])await copyFile(file,resolve(stage,file));
await cp('dist',resolve(stage,'dist'),{recursive:true});
run('npm',['ci',...(process.argv.includes('--offline')?['--offline']:[]),'--omit=dev','--ignore-scripts','--no-audit','--no-fund'],stage);
await rm(archive,{force:true});run('zip',['-qr',archive,'.'],stage);
const sha=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(archive+'.sha256',`${sha}  personal-memory-azure.zip\n`);
console.log(`Packaged ${archive}\nSHA-256 ${sha}`);
