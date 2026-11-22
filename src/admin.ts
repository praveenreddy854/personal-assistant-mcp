import 'dotenv/config';
import { readFile,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Database } from './db.js';
import { ReceiptSchema,reapplyDeletionReceipt,invalidateRestoredFamilyVault } from './restore.js';

async function main(){
  const endpoint=process.env.COSMOS_ENDPOINT;if(!endpoint)throw new Error('COSMOS_ENDPOINT is required');
  const local=['localhost','127.0.0.1','[::1]'].includes(new URL(endpoint).hostname);
  if(process.env.COSMOS_KEY&&!local)throw new Error('Azure Cosmos DB uses Entra credentials, not account keys');
  const db=new Database({endpoint,database:process.env.COSMOS_DATABASE,container:process.env.COSMOS_CONTAINER,directoryContainer:process.env.COSMOS_DIRECTORY_CONTAINER,key:process.env.COSMOS_KEY});
  try{
    await db.initialize();
    const command=process.argv[2];
    if(command==='initialize')console.log('Cosmos containers verified. Azure infrastructure creates the partition and vector policies.');
    else if(command==='invite'){
      const [issuer,subject,email]=process.argv.slice(3);if(!issuer||!subject)throw new Error('Usage: npm run invite -- <issuer> <stable-subject-or-oid> [display-email]');
      console.log(`Invited identity. Vault: ${await db.invite({issuer,subject},email)}`);
    }else if(command==='add-member'){
      const name=process.argv.slice(3).join(' ').trim();if(!name)throw new Error('Usage: npm run add-member -- <name>');
      console.log(`Added ${name}. Give them this token (shown once) to use as "Authorization: Bearer <token>":\n${await db.addMember(name)}`);
    }else if(command==='remove-member'){
      const name=process.argv.slice(3).join(' ').trim();if(!name)throw new Error('Usage: npm run remove-member -- <name>');
      console.log(`Revoked ${await db.removeMember(name)} token(s) for ${name}. Their memories stay in the family vault.\nRun export-deletions now so a later backup restore keeps this removal.`);
    }else if(command==='export-deletions'){
      const path=process.argv[3];if(!path)throw new Error('Provide an export path independent of database backups.');
      const identities=await db.directory.items.query<{vault_id:string}>('SELECT c.vault_id FROM c').fetchAll(),receipts=[];
      for(const vault of new Set(identities.resources.map(r=>r.vault_id)))receipts.push(...await db.withVaultId(vault,false,tx=>tx.find('deletion_receipts'),undefined,true));
      await writeFile(path,JSON.stringify(receipts,null,2),{mode:0o600});console.log(`Exported ${receipts.length} content-free deletion receipts to ${path}`);
      const grants=await db.memberGrants();
      await writeFile(`${path}.grants.json`,JSON.stringify({exported_at:new Date().toISOString(),grants}),{mode:0o600});console.log(`Exported ${grants.length} current family token grants to ${path}.grants.json`);
    }else if(command==='restore-deletions'){
      if(process.env.SERVING_ENABLED!=='false')throw new Error('Set SERVING_ENABLED=false and disable the deployed application before restore replay');
      const path=process.argv[3];if(!path)throw new Error('Provide a receipt export newer than the restored backup');
      const receipts=z.array(ReceiptSchema).parse(JSON.parse(await readFile(path,'utf8')));
      for(const receipt of receipts)await reapplyDeletionReceipt(db,receipt);
      // Remove family members whose tokens were revoked after the restored backup was taken.
      const grantsFile=await readFile(`${path}.grants.json`,'utf8').catch(()=>null);
      if(grantsFile){
        const parsed=JSON.parse(grantsFile),list=Array.isArray(parsed)?{exported_at:'unknown',grants:parsed}:parsed;
        console.log(`Grant list exported at ${list.exported_at}; any member removed after that is NOT covered. Re-run remove-member for them before enabling serving.`);
        console.log(`Removed ${await db.pruneGrants(z.array(z.string()).parse(list.grants))} family token grants revoked after the backup.`);
      }
      else if((await db.memberGrants()).length)throw new Error(`Family token grants exist but ${path}.grants.json is missing; export again with export-deletions before enabling serving.`);
      if(await invalidateRestoredFamilyVault(db))console.log('Revoked restored family-vault capture secrets, pending proposals and cached results.');
      console.log(`Reapplied ${receipts.length} receipts. Verify the restored store before enabling serving; capture secrets were revoked.`);
    }else throw new Error('Use initialize, invite, add-member, remove-member, export-deletions or restore-deletions');
  }finally{await db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
