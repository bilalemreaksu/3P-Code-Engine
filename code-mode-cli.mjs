import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { modelProviders, toolProtocols } from './code-mode-model.mjs';

const safe = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c=>JSON.stringify(c).slice(1,-1));

export async function terminalOptions(argv, env = process.env) {
  const options = {};
  const names = ['endpoint','model','api-key','cwd','resume','permission-mode','classifier-endpoint','classifier-model','isolation','config','provider','tool-protocol'];
  for (let i=0;i<argv.length;i++) {
    const key = argv[i].replace(/^--/,'');
    if (argv[i] === '--help') return {help:true};
    // Enablement is an action, not a value flag: it only touches the trusted
    // user setting and never starts a session (no endpoint required).
    if (argv[i] === '--enable' || argv[i] === '--disable') { options[key] = true; continue; }
    if (!argv[i].startsWith('--') || !names.includes(key) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error(`Invalid option: ${argv[i]}`);
    options[key] = argv[++i];
  }
  if (options.enable && options.disable) throw new Error('Use either --enable or --disable, not both');
  if (options.config) {
    const config = JSON.parse(await readFile(path.resolve(options.config),'utf8'));
    const configured = config.mcpServers?.['3p-code-mode']?.env;
    if (!configured) throw new Error('Config has no 3p-code-mode server');
    // Explicit environment and command-line values take precedence.
    for (const [key,value] of Object.entries(configured)) if (/^(CODE_MODE_|REVIEW_MODEL_)/.test(key) && typeof value === 'string' && env[key] === undefined) env[key] = value;
  }
  env.CODE_MODE_PERMISSION_MODE = options['permission-mode'] ?? env.CODE_MODE_PERMISSION_MODE ?? 'autoApprove';
  if (options.isolation) env.CODE_MODE_ISOLATION = options.isolation;
  const endpoint = options.endpoint ?? env.CODE_MODE_MODEL_ENDPOINT ?? env.REVIEW_MODEL_ENDPOINT ?? env.CODE_MODE_CLASSIFIER_ENDPOINT;
  const model = options.model ?? env.CODE_MODE_MODEL_NAME ?? env.REVIEW_MODEL_NAME ?? env.CODE_MODE_CLASSIFIER_MODEL;
  env.CODE_MODE_CLASSIFIER_ENDPOINT = options['classifier-endpoint'] ?? env.CODE_MODE_CLASSIFIER_ENDPOINT ?? endpoint;
  env.CODE_MODE_CLASSIFIER_MODEL = options['classifier-model'] ?? env.CODE_MODE_CLASSIFIER_MODEL ?? model;
  const apiKey=options['api-key'] ?? env.CODE_MODE_MODEL_API_KEY ?? env.REVIEW_MODEL_API_KEY;
  if(!env.CODE_MODE_CLASSIFIER_API_KEY && apiKey)env.CODE_MODE_CLASSIFIER_API_KEY=apiKey;
  // The enablement actions do not start a session and need no model settings.
  if (options.enable !== undefined) return {endpoint,model,apiKey,enable:options.enable,cwd:options.cwd ? path.resolve(options.cwd) : undefined};
  if (!endpoint || !model) throw new Error('Set --endpoint and --model, or load your Desktop configuration with --config');
  if (!['rules','default','acceptEdits','plan','auto','bypassPermissions','autoApprove'].includes(env.CODE_MODE_PERMISSION_MODE)) throw new Error('Invalid permission mode');
  if (env.CODE_MODE_ISOLATION && !['off','docker'].includes(env.CODE_MODE_ISOLATION)) throw new Error('Invalid isolation mode');
  const provider = options.provider ?? env.CODE_MODE_MODEL_PROVIDER;
  const toolProtocol = options['tool-protocol'] ?? env.CODE_MODE_TOOL_PROTOCOL;
  if (provider && !modelProviders.includes(provider)) throw new Error('Invalid model provider');
  if (toolProtocol && !toolProtocols.includes(toolProtocol)) throw new Error('Invalid tool protocol');
  return {endpoint,model,apiKey,provider,toolProtocol,permissionMode:options['permission-mode'],cwd:options.cwd ? path.resolve(options.cwd) : undefined,resume:options.resume};
}

export async function runTerminal(options, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) throw new Error('Code Mode requires an interactive terminal');
  // Dynamic imports: dataDir and the settings must see the final env, which
  // terminalOptions (--config) may still have adjusted.
  const [{CodeModeAgent,cyclePermissionMode},{renderViewer,viewerKey},{dataDir},{assertProjectEnabled}] = await Promise.all([import('./code-mode-agent.mjs'),import('./code-mode-transcript.mjs'),import('./execution-manager.mjs'),import('./code-mode-settings.mjs')]);
  const lines = [], approvals = new Set();
  const view = {jobs:[],selected:0,expanded:new Set(),transcript:true};
  let agent, buffer='', cursor=0, transcript=false, stopped=false, controller, busy=false, currentTurn, lastFrame;
  const append = text => {lines.push(safe(text)); if(lines.length>1000)lines.splice(0,lines.length-1000);};
  const draw = () => {
    if(stopped)return;
    const content = transcript ? renderViewer({...view,jobs:agent?.snapshot() ?? []}) : lines.slice(-35).join('\n');
    const frame=`\x1b[2J\x1b[H${content}\n\n${busy ? 'Çalışıyor' : 'Siz'} > ${safe(buffer)}\x1b[K${cursor<buffer.length ? `\x1b[${buffer.length-cursor}D` : ''}`;
    if(frame!==lastFrame){lastFrame=frame;output.write(frame);}
  };
  const onEvent = event => {
    if(event.kind==='assistant' || event.kind==='protocol') append(event.text);
    if(event.kind==='operation') {
      try { const op=JSON.parse(event.data); append(`${op.operation}: ${op.file ?? op.command ?? op.server ?? ''}`); if(op.operation==='edit')append(`- ${op.oldText}\n+ ${op.newText}`); } catch {append(event.data);}
    } else if(['stdout','stderr','log'].includes(event.kind)) append(event.data);
    else if(event.kind==='approval' && event.url && !approvals.has(event.id)) {approvals.add(event.id);append(`Onay gerekiyor: ${event.tool} · ${event.deadline}\n${event.url}`);}
    else if(event.kind==='job') append(`Code · ${event.background ? 'arka plan' : 'ön plan'} · ${event.jobId} · Ctrl+O ile görüntüle`);
    draw();
  };
  // Initial state check: a new session only starts for a project the user
  // enabled in the trusted user settings. A resume is checked inside
  // CodeModeAgent.resume with the session's saved cwd.
  if (!options.resume) assertProjectEnabled(dataDir, options.cwd ?? process.cwd());
  agent = options.resume ? await CodeModeAgent.resume(options.resume,{...options,onEvent}) : new CodeModeAgent({...options,cwd:options.cwd ?? process.cwd(),onEvent});
  await agent.save();
  append(`Code Mode (experimental) açık · ${agent.mode} · ${agent.id} · arka plan: ${agent.backgroundEligible ? 'uygun' : 'kapalı'}\n${agent.cwd}\nCtrl+O: kod kaydı · Ctrl+C: iptal · Shift+Tab: izin modu · /mode: göster/değiştir · /exit: çıkış · /status: işler`);
  const queue = [];
  const send = async () => {
    if(busy || !queue.length || stopped)return;
    busy=true; controller=new AbortController(); draw();
    const item=queue.shift();
    try {currentTurn=agent.turn(item.prompt,controller.signal,{backgroundJobId:item.jobId,source:item.source ?? 'user'});await currentTurn;}
    catch(error){append(`Hata: ${error.message}`);}
    finally {busy=false;draw();void send();}
  };
  const observed = new Set(agent.deliveredBackground);
  const timer = setInterval(() => {
    for(const job of agent.snapshot()) {
      if(job.status==='running') {for(const approval of job.pendingApprovals || [])onEvent({kind:'approval',...approval});continue;}
      if(!job.finishedAt || observed.has(job.id))continue;
      observed.add(job.id);
      // Foreground results are already in their tool response. Background
      // completion is delivered as a new model event after the current turn.
      if(agent.backgroundJobs.has(job.id)) {append(`Arka plan ${job.id}: ${job.status}`);queue.push({prompt:`Background code output (poll_event): ${JSON.stringify(job.result)}`,jobId:job.id,source:'poll_event'});void send();}
    }
    if(transcript)draw();
  },500);
  emitKeypressEvents(input);
  const wasRaw=input.isRaw;
  input.setRawMode(true);input.resume();
  try {
    draw();
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{input.removeListener('keypress',onKey);input.removeListener('end',onEnd);input.removeListener('error',onError);};
      const onEnd=()=>{cleanup();resolve();};
      const onError=error=>{cleanup();reject(error);};
      const onKey=(text,key={})=>{
        if(key.ctrl && key.name==='c'){controller?.abort();agent.cancel();buffer='';cursor=0;draw();return;}
        if(key.ctrl && key.name==='d' && !buffer){onEnd();return;}
        if(key.ctrl && key.name==='o'){transcript=!transcript;draw();return;}
        if(transcript){view.jobs=agent.snapshot();if(!viewerKey(view,key))transcript=false;draw();return;}
        // Only the human at the terminal may change the permission mode —
        // Shift+Tab cycles it, /mode shows or sets it. No model tool can.
        // The background save is fire-and-forget: a failure must surface as a
        // visible line, never as an unhandled rejection that kills the shell.
        const setMode=next=>{const prev=agent.mode;agent.setMode(next);void agent.save().catch(error=>{append(`Oturum kaydedilemedi: ${error.message}`);draw();});append(`İzin modu: ${prev} → ${agent.mode} · arka plan: ${agent.backgroundEligible ? 'uygun' : 'kapalı'}`);};
        if(key.shift && key.name==='tab'){setMode(cyclePermissionMode(agent.mode));draw();return;}
        if(key.name==='return') {
          const prompt=buffer.trim();buffer='';cursor=0;
          if(prompt==='/exit'){onEnd();return;}
          if(prompt==='/status'){for(const job of agent.snapshot())append(`${job.id}: ${job.status}`);draw();return;}
          if(prompt==='/mode'){append(`İzin modu: ${agent.mode} · arka plan: ${agent.backgroundEligible ? 'uygun' : 'kapalı'} (Shift+Tab veya /mode <mod>)`);draw();return;}
          if(prompt.startsWith('/mode ')){try{setMode(prompt.slice(6).trim());}catch(error){append(`Hata: ${error.message}`);}draw();return;}
          if(prompt){append(`Siz: ${prompt}`);queue.push({prompt});void send();}else draw();return;
        }
        if(key.name==='backspace'){if(cursor){buffer=buffer.slice(0,cursor-1)+buffer.slice(cursor);cursor--;}draw();return;}
        if(key.name==='left')cursor=Math.max(0,cursor-1);
        else if(key.name==='right')cursor=Math.min(buffer.length,cursor+1);
        else if(text && !key.ctrl && !key.meta){const value=text.replace(/[\r\n]/g,' ');buffer=buffer.slice(0,cursor)+value+buffer.slice(cursor);cursor+=value.length;}
        draw();
      };
      input.on('keypress',onKey);input.once('end',onEnd);input.once('error',onError);
    });
  } finally {
    stopped=true;clearInterval(timer);controller?.abort();await agent.close();await currentTurn?.catch(()=>{});
    input.setRawMode(Boolean(wasRaw));input.pause();input.unref?.();
    output.write(`\nDevam: node code-mode-cli.mjs --resume ${agent.id} --endpoint ${options.endpoint} --model ${options.model} --provider ${agent.provider}\n`);
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    const options=await terminalOptions(process.argv.slice(2));
    if(options.help)console.log('node code-mode-cli.mjs --endpoint <API base URL> --model <model> [--provider openai|anthropic|gemini] [--tool-protocol auto|native|text] [--permission-mode autoApprove|auto|default|acceptEdits|plan|bypassPermissions|rules] [--cwd <project>] [--resume <id>] [--config <Desktop config>] [--isolation docker] | --enable|--disable [--cwd <project>]');
    else if(options.enable!==undefined) {
      const { dataDir } = await import('./execution-manager.mjs');
      const { setProjectEnabled } = await import('./code-mode-settings.mjs');
      const cwd = options.cwd ?? process.cwd();
      await setProjectEnabled(dataDir, cwd, options.enable);
      console.log(options.enable ? `Code Mode etkinleştirildi: ${cwd}` : `Code Mode kapatıldı: ${cwd}`);
    }
    else await runTerminal(options);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
