import { spawnSync } from 'node:child_process';
import { CosmosClient } from '@azure/cosmos';
const name='personal-memory-cosmos';
const image='mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator@sha256:db53613dae19d0a3d5ad50688d14aa6e957af082dafea56b52e1bd3a6b3f1406';
function run(args,quiet=false){return spawnSync('docker',args,{encoding:'utf8',stdio:quiet?'pipe':'inherit'});}
if(process.argv[2]==='stop')process.exitCode=run(['stop',name]).status??1;
else{
  const exists=run(['inspect','--format','{{.State.Running}}',name],true);
  const result=exists.status===0?run(['start',name]):run(['run','-d','--name',name,'-p','127.0.0.1:8081:8081','-p','127.0.0.1:1234:1234',image,'--protocol','http']);
  if(result.status!==0)process.exitCode=result.status??1;
  else{
    const client=new CosmosClient({endpoint:'http://127.0.0.1:8081',key:Buffer.from('local-emulator-test-key').toString('base64'),connectionPolicy:{enableEndpointDiscovery:false,retryOptions:{maxRetryAttemptCount:0}}});
    try{for(let i=0;;i++){try{await client.databases.readAll().fetchAll();break;}catch(error){if(i>=59)throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}console.log('Cosmos emulator ready at http://127.0.0.1:8081');}
    finally{client.dispose();}
  }
}
