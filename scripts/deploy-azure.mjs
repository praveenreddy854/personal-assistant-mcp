import { spawnSync } from 'node:child_process';
import { readFile,access } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const usage=`Deploy Personal Memory to Azure Functions

Full deployment:
  npm run deploy:azure -- --resource-group RG --parameters memory.parameters.local.json
Update an existing Function App without reprovisioning:
  npm run deploy:azure -- --resource-group RG --code-only --function-app APP

Options:
  --subscription ID       Use this subscription without changing the CLI default
  --location REGION       Resource and resource-group location (default: parameter file/centralus)
  --initialize            Verify Cosmos containers from a network-connected runner
  --cosmos-endpoint URL   Expected Cosmos endpoint for --code-only --initialize
  --enable-serving       Enable memory requests after initialization
  --store-ready       Attest containers and identity configuration are ready
  --skip-tests           Skip server, deployment-script, and browser tests
  --dry-run              Print the commands; execute nothing and reveal no parameter values

Full provisioning starts with serving paused. Azure model deployments must already
exist; configure Google federation before enabling serving. See docs/deployment.md.`;

export function parseOptions(argv){
  const values=new Set(['resource-group','parameters','subscription','location','function-app','cosmos-endpoint']);
  const flags=new Set(['code-only','initialize','enable-serving','store-ready','skip-tests','dry-run','help']);
  const options={};
  for(let i=0;i<argv.length;i++){
    const name=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--')||(!values.has(name)&&!flags.has(name)))throw new Error(`Unknown deployment option: ${argv[i]}`);
    if(flags.has(name))options[name]=true;
    else{
      const value=argv[++i];if(!value||value.startsWith('--'))throw new Error(`--${name} requires a value`);
      options[name]=value;
    }
  }
  if(options.help)return options;
  if(!options['resource-group'])throw new Error('--resource-group is required');
  if(options['code-only']&&!options['function-app'])throw new Error('--code-only requires --function-app');
  if(!options['code-only']&&!options.parameters)throw new Error('Full deployment requires --parameters; use the private parameter file described in docs/deployment.md');
  if(options['enable-serving']&&!options.initialize&&!options['store-ready'])throw new Error('--enable-serving requires --initialize or an explicit --store-ready attestation');
  if(options['code-only']&&options.initialize&&!options['cosmos-endpoint'])throw new Error('--code-only --initialize requires --cosmos-endpoint to verify the initialization target');
  return options;
}

function defaultRunner(command,args,{capture=false,env={}}={}){
  const result=spawnSync(command,args,{cwd:project,env:{...process.env,...env},shell:false,
    stdio:capture?['inherit','pipe','inherit']:'inherit',encoding:'utf8'});
  if(result.error?.code==='ENOENT')throw new Error(`${command} is not installed or is not on PATH`);
  if(result.error||result.status!==0)throw new Error(`${command} failed; see its output above. No later deployment steps were run.`);
  return result.stdout??'';
}

export function initializationEnvironment(parameters,endpoint,env){
  if(!endpoint||new URL(endpoint).protocol!=='https:')throw new Error('An expected HTTPS Cosmos endpoint is required');
  if(env.COSMOS_ENDPOINT&&new URL(env.COSMOS_ENDPOINT).origin!==new URL(endpoint).origin)throw new Error('COSMOS_ENDPOINT must target this deployment');
  if(env.COSMOS_KEY)throw new Error('Azure initialization requires Entra credentials; remove COSMOS_KEY');
  return {COSMOS_ENDPOINT:endpoint,COSMOS_DATABASE:'memory',COSMOS_CONTAINER:'vaults',COSMOS_DIRECTORY_CONTAINER:'identities',COSMOS_KEY:''};
}

export async function deploy(argv,{runner=defaultRunner,env=process.env,log=console.log,verifyArchive=access}={}){
  const o=parseOptions(argv);if(o.help){log(usage);return;}
  let parameters={};
  const parameterPath=o.parameters?resolve(o.parameters):undefined;
  if(parameterPath){
    let contents;try{contents=JSON.parse(await readFile(parameterPath,'utf8'));}catch{throw new Error('The parameter file must exist and contain valid Azure deployment-parameters JSON');}
    if(!contents.parameters||typeof contents.parameters!=='object')throw new Error('The parameter file requires a parameters object');
    parameters=contents.parameters;
  }
  const model=parameters.modelResourceName?.value;
  if(!o['code-only']&&typeof model!=='string')throw new Error('Set modelResourceName.value to the existing Azure OpenAI account');
  if(!o['dry-run']&&!o['code-only']&&model==='EXISTING_AZURE_OPENAI_ACCOUNT')throw new Error('Replace the example parameters with actual deployment values before deploying');
  const location=o.location??parameters.location?.value??'centralus';
  const subscription=o.subscription?['--subscription',o.subscription]:[];
  const az=(args,options={})=>execute('az',[...args,...subscription,'--only-show-errors'],options);
  const execute=(command,args,options={})=>{
    if(o['dry-run']){log([command,...args.map(arg=>JSON.stringify(arg))].join(' '));return '';}
    return runner(command,args,options);
  };
  if(o['dry-run'])log('DRY RUN: no commands will execute; private parameter values are not printed.');
  az(['account','show','--output','none']);
  if(!o['code-only']){
    const state=az(['provider','show','--namespace','Microsoft.App','--query','registrationState','--output','tsv'],{capture:true});
    if(!o['dry-run']&&state.trim()!=='Registered')throw new Error('Register Microsoft.App in the target subscription before deploying Functions with VNet integration. Run az provider register --namespace Microsoft.App --wait with the same subscription. No resources were created by this run.');
    const exists=az(['group','exists','--name',o['resource-group'],'--output','tsv'],{capture:true});
    if(o['dry-run']||exists.trim()==='true'){
      const rawResources=az(['resource','list','--resource-group',o['resource-group'],'--query','[].{name:name,type:type,location:location}','--output','json'],{capture:true});
      if(!o['dry-run']){
        const networkName=`${parameters.prefix?.value??'personalmemory'}-vnet`;
        const network=JSON.parse(rawResources).find(item=>item.type==='Microsoft.Network/virtualNetworks'&&item.name===networkName);
        if(network&&network.location.toLowerCase()!==location.toLowerCase())throw new Error(`The existing ${networkName} is in ${network.location} and cannot be moved to ${location} by redeployment. Use a fresh resource group or prefix; review the old resources separately. No resources were changed by this run.`);
      }
    }
  }
  execute('npm',['run','build']);
  if(!o['skip-tests']){
    execute('npm',['test']);execute('npm',['run','test:deploy']);execute('npm',['run','test:browser']);
  }
  execute('npm',['run','package:azure','--','--skip-build']);
  let app=o['function-app'],mcp,endpoint=o['cosmos-endpoint'];
  if(!o['code-only']){
    az(['group','create','--name',o['resource-group'],'--location',location,'--output','none']);
    az(['cognitiveservices','account','show','--resource-group',parameters.modelResourceGroup?.value??o['resource-group'],'--name',model,'--output','none']);
    const deployment=['deployment','group'];
    const args=['--resource-group',o['resource-group'],'--template-file',resolve(project,'infra/main.bicep'),'--parameters',`@${parameterPath}`,`location=${location}`];
    az([...deployment,'validate',...args,'--output','none']);
    const raw=az([...deployment,'create',...args,'--query','properties.outputs','--output','json'],{capture:true});
    const outputs=o['dry-run']?{functionAppName:{value:'FUNCTION_APP_FROM_BICEP'},mcpUrl:{value:'https://FUNCTION_HOST/mcp'},cosmosEndpoint:{value:'https://COSMOS_ACCOUNT.documents.azure.com/'}}:JSON.parse(raw);
    app=outputs.functionAppName?.value;mcp=outputs.mcpUrl?.value;endpoint=outputs.cosmosEndpoint?.value;
    if(!app||!mcp||!endpoint)throw new Error('Bicep deployment did not return the expected Function App, MCP URL, and Cosmos endpoint outputs');
  }else{
    const hostname=az(['functionapp','show','--resource-group',o['resource-group'],'--name',app,'--query','defaultHostName','--output','tsv'],{capture:true});
    mcp=`https://${o['dry-run']?app+'.azurewebsites.net':hostname.trim()}/mcp`;
  }
  if(o.initialize){
    const storeEnv=o['dry-run']?{}:initializationEnvironment(parameters,endpoint,env);
    execute('npm',['run','db:initialize'],{env:storeEnv});
  }
  const archive=resolve(project,'artifacts/personal-memory-azure.zip');
  if(!o['dry-run'])await verifyArchive(archive);
  az(['functionapp','deployment','source','config-zip','--resource-group',o['resource-group'],'--name',app,'--src',archive,'--build-remote','false','--output','none']);
  if(o['enable-serving'])az(['functionapp','config','appsettings','set','--resource-group',o['resource-group'],'--name',app,'--settings','SERVING_ENABLED=true','--output','none']);
  const serving=o['enable-serving']?'enabled':o['code-only']?'unchanged':'paused until Cosmos and OAuth configuration are ready';
  log(`${o['dry-run']?'Planned':'Published'} MCP: ${mcp}\nMemory serving: ${serving}`);
  return {functionApp:app,mcpUrl:mcp,cosmosEndpoint:endpoint,serving};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  deploy(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
