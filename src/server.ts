import { loadConfig } from './config.js';
import { Database } from './db.js';
import { AzureAI } from './ai.js';
import { MemoryService } from './memory.js';
import { createApp } from './app.js';

const config=loadConfig();
const database=new Database(config.cosmos);
await database.initialize();
const memory=new MemoryService(database,new AzureAI(config),config.EMBEDDING_VERSION);
const port=Number(process.env.FUNCTIONS_CUSTOMHANDLER_PORT??config.PORT);
const server=createApp(config,memory).listen(port,config.AUTH_MODE==='development'?'127.0.0.1':'0.0.0.0',()=>console.log(`Personal memory listening on port ${port}`));
async function stop() {server.close();await database.close();}
process.on('SIGINT',()=>void stop());
process.on('SIGTERM',()=>void stop());
