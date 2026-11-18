import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { dataDir, startExecution, getJob, cancelJob, resetApprovalTimeouts } from './execution-manager.mjs';
import { classifyCode } from './code-mode-classifier.mjs';
import { getPermissionMode, permissionModes, backgroundModes } from './code-mode-policy.mjs';
import { assertProjectEnabled } from './code-mode-settings.mjs';

export const cyclePermissionMode = current => permissionModes[(permissionModes.indexOf(current) + 1) % permissionModes.length];

export const agentTools = [
  { type:'function', function:{ name:'REPL', description:'Execute JavaScript to perform all file, shell and MCP operations. Helpers: read, write, edit, run, $, log, tools.Read/Write/Edit/Bash, listMcpServers, listMcpTools, callMcp. Return an expression or use return. Use Promise.all for independent calls. Background execution returns a job ID immediately.', parameters:{ type:'object', properties:{code:{type:'string'},background:{type:'boolean'},timeoutMs:{type:'integer',minimum:1000,maximum:7200000}},required:['code'],additionalProperties:false } } },
  { type:'function', function:{ name:'code_status', description:'Read job events/results and pending human approval URLs. Cannot approve anything.', parameters:{type:'object',properties:{jobId:{type:'string'},afterSequence:{type:'integer',minimum:0}},required:['jobId'],additionalProperties:false} } },
  { type:'function', function:{ name:'code_cancel', description:'Cancel a running job.', parameters:{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false} } },
];

export const agentInstructions = `You are a coding assistant in a Code Mode terminal session. All actions MUST use REPL JavaScript; no other OS or native client tools are available. Use read/write/edit/run/$ and configured MCP helpers. Generated JavaScript has no Node.js, process, fetch, require or import access. Group related calls, run independent ones with Promise.all, and return only useful output. A final JavaScript expression is returned automatically. Explicit JSON state persists for foreground code; background jobs have independent state. Do not attempt to change permissions, approve your own requests, access engine configuration or evade a refusal. Pending approvals must be answered by the human in the approval UI. Use background:true for long builds/tests when available so the user can keep talking. Never poll in a tight loop. Report errors and verification honestly.`;

const sessionPath = id => path.join(dataDir, `chat-${createHash('sha256').update(id).digest('hex')}.json`);

export class CodeModeAgent {
  constructor({ endpoint, model, apiKey, cwd, id = randomUUID(), messages = [], jobs = [], backgroundJobs = [], deliveredBackground = [], onEvent = () => {}, request = fetch, mode, initialMode }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid model endpoint');
    if (!model) throw new Error('A model is required');
    if (!path.isAbsolute(cwd)) throw new Error('cwd must be absolute');
    Object.assign(this, {endpoint:endpoint.replace(/\/$/,''), model, apiKey, cwd, id, messages, jobs, onEvent, request});
    if (mode !== undefined && !permissionModes.includes(mode)) throw new Error(`Invalid permission mode: ${String(mode)}`);
    // The session carries its own permission state: the initial mode comes
    // from the launch options/env, the current mode is mutable at runtime
    // (terminal Shift+Tab or /mode) and background eligibility follows it.
    this.initialMode = initialMode ?? mode ?? getPermissionMode();
    this.mode = mode ?? this.initialMode;
    this.backgroundEligible = backgroundModes.includes(this.mode);
    // A direct tool call is not a real user message.
    this.turnSource = 'model';
    // The prompt of the current turn, kept separately because it is the only
    // trusted user-intent source the classifier may carry (see turn()).
    this.currentTurnPrompt = undefined;
    this.backgroundJobs = new Set(backgroundJobs);
    this.deliveredBackground = new Set(deliveredBackground);
    this.pending = new Set();
    this.active = false;
  }
  static async resume(id, options) {
    if (options.permissionMode !== undefined && !permissionModes.includes(options.permissionMode)) throw new Error(`Invalid permission mode: ${String(options.permissionMode)}`);
    // The Code Mode marker is validated with an explicit reason for every
    // way a resume can fail, so the user knows why — and what to do.
    let raw;
    try { raw = await readFile(sessionPath(id), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Unknown Code Mode session: ${id}`);
      throw new Error(`Code Mode session ${id} could not be read (${error.code}); start a new session`);
    }
    let saved;
    try { saved = JSON.parse(raw); }
    catch { throw new Error(`Code Mode session ${id} is corrupted (invalid JSON); start a new session`); }
    if (saved?.codeMode !== true) throw new Error('This file is not a Code Mode session (missing codeMode marker); start a new session');
    if (saved.version !== 1) throw new Error(`Code Mode session ${id} uses unsupported version ${String(saved.version)}; start a new session`);
    if (typeof saved.cwd !== 'string' || !path.isAbsolute(saved.cwd)) throw new Error(`Code Mode session ${id} is corrupted (missing cwd); start a new session`);
    // The launch env no longer pins a resumed session: it keeps the mode it
    // was saved with. An explicit --permission-mode is a trusted human choice
    // that moves the session, like the terminal's /mode — not an error.
    if (options.cwd && path.resolve(options.cwd) !== saved.cwd) throw new Error('Session belongs to a different working directory');
    // Code Mode must still be enabled for the session's project.
    assertProjectEnabled(dataDir, saved.cwd);
    // A crash can persist an assistant tool request before its result. Mark
    // missing results interrupted instead of replaying effects or sending an
    // invalid tool-call conversation to the model endpoint.
    const completed=new Set(saved.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id));
    const pending=saved.messages.flatMap(message=>message.role==='assistant' ? message.tool_calls ?? [] : []).filter(call=>!completed.has(call.id));
    for(const call of pending)saved.messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({ok:false,error:'Session interrupted before this tool result was saved; effects are unknown. Inspect the project before retrying.'})});
    return new CodeModeAgent({ ...options, ...saved, id, ...(options.permissionMode !== undefined ? { mode: options.permissionMode } : {}) });
  }
  async save() {
    await mkdir(dataDir, {recursive:true, mode:0o700});
    const target = sessionPath(this.id);
    const payload = JSON.stringify({version:1,codeMode:true,id:this.id,cwd:this.cwd,mode:this.mode,messages:this.messages,jobs:this.jobs.slice(-100),backgroundJobs:[...this.backgroundJobs].slice(-100),deliveredBackground:[...this.deliveredBackground].slice(-100)});
    // A transient OS hiccup must not lose the saved conversation: the rename
    // can hit EPERM while the target is locked, or ENOENT when the temp file
    // vanishes (both observed on Windows). Each attempt uses a fresh temp.
    for (let delay = 150; ; delay *= 2) {
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, payload, {mode:0o600});
        await rename(temp, target);
        return;
      } catch (error) {
        await rm(temp, { force: true });
        if (!['EPERM','EACCES','EBUSY','ENOENT'].includes(error.code) || delay > 1200) throw error;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  async execute(name, args, signal) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
    if (name === 'code_status' || name === 'code_cancel') {
      // The model cannot inspect another session's jobs or grant approvals.
      if (!this.jobs.includes(args.jobId)) throw new Error('Job does not belong to this session');
      return name === 'code_status' ? getJob(args.jobId,args.afterSequence ?? 0) : cancelJob(args.jobId);
    }
    if (name !== 'REPL') throw new Error(`Unavailable tool: ${name}`);
    if (Object.keys(args).some(key => !['code','background','timeoutMs'].includes(key))) throw new Error('Unknown REPL argument');
    if (args.background !== undefined && typeof args.background !== 'boolean') throw new Error('background must be boolean');
    const background = args.background === true;
    const job = await startExecution({cwd:this.cwd,code:args.code,background,timeoutMs:args.timeoutMs ?? (background ? 7200000 : 600000),sessionId:background ? undefined : `terminal:${this.id}`,mode:this.mode,source:this.turnSource,decide:(kind,event,signal) => {
      if (kind !== 'classify') throw new Error('Unexpected permission request');
      // Only the request the human typed in the current turn is trusted
      // intent: a poll_event turn (a synthetic completion message) and a
      // direct model tool call carry none, and code comments can never
      // enter this field.
      const intent = this.turnSource === 'user' ? this.currentTurnPrompt : undefined;
      return classifyCode(event,signal,intent);
    }});
    this.pending.add(job.promise);void job.promise.then(()=>this.pending.delete(job.promise));
    this.jobs.push(job.id); if(background)this.backgroundJobs.add(job.id);
    this.onEvent({kind:'job',jobId:job.id,background});
    try {await this.save();}
    catch(error){cancelJob(job.id);await job.promise;throw error;}
    if (background) return getJob(job.id);
    const abort = () => cancelJob(job.id);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    let sequence = 0;
    const inspect = () => {
      const current = getJob(job.id,sequence);
      for (const event of current.events) {sequence = event.sequence; this.onEvent({...event,jobId:job.id});}
      for (const approval of current.pendingApprovals || []) this.onEvent({kind:'approval',jobId:job.id,...approval});
    };
    const timer = setInterval(inspect,150);
    try { const result = await job.promise; inspect(); return result; }
    finally { clearInterval(timer); signal?.removeEventListener('abort',abort); }
  }
  async turn(prompt, signal, {backgroundJobId, source = 'user'} = {}) {
    if (this.active) throw new Error('Wait for the current response before sending another prompt');
    if (!['user','poll_event'].includes(source)) throw new Error(`Invalid turn source: ${String(source)}`);
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A prompt is required');
    this.active = true;
    this.turnSource = source;
    this.currentTurnPrompt = source === 'user' ? prompt : undefined;
    // Only a real user message re-arms this session's timed-out approvals;
    // a synthetic poll_event must not resurrect expired countdowns.
    if (source === 'user') resetApprovalTimeouts(this.jobs);
    this.messages.push({role:'user',content:prompt});
    try {
      await this.save();
      for (let step = 0; step < 100; step++) {
        const response = await this.request(`${this.endpoint}/chat/completions`, {method:'POST',signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),headers:{'content-type':'application/json',...(this.apiKey ? {authorization:`Bearer ${this.apiKey}`} : {})},body:JSON.stringify({model:this.model,messages:[{role:'system',content:agentInstructions},...this.messages],tools:agentTools,tool_choice:'auto',max_tokens:8192})});
        if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
        const message = (await response.json()).choices?.[0]?.message;
        if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) throw new Error('Invalid assistant response');
        // Copy only protocol fields, never arbitrary provider metadata.
        const calls = message.tool_calls;
        if (calls && (!calls.length || calls.length > 32 || calls.some(call => call.type !== 'function' || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || new Set(calls.map(c=>c.id)).size !== calls.length)) throw new Error('Invalid tool calls');
        this.messages.push({role:'assistant',content:message.content ?? null,...(calls ? {tool_calls:calls} : {})});
        if (message.content) this.onEvent({kind:'assistant',text:message.content});
        if (!calls) {
          if(backgroundJobId && this.backgroundJobs.has(backgroundJobId))this.deliveredBackground.add(backgroundJobId);
          await this.save(); return message.content;
        }
        for (const call of calls) {
          let result;
          try { signal?.throwIfAborted(); result = await this.execute(call.function.name,JSON.parse(call.function.arguments),signal); }
          catch (error) {result = {ok:false,error:error.message};}
          this.messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
          await this.save();
        }
      }
      throw new Error('Tool round limit reached; send a new prompt to continue');
    } finally {this.active = false;}
  }
  setMode(next) {
    if (!permissionModes.includes(next)) throw new Error(`Invalid permission mode: ${String(next)}`);
    this.mode = next;
    this.backgroundEligible = backgroundModes.includes(next);
    return this.mode;
  }
  snapshot() { return this.jobs.map(id => {try{return getJob(id);}catch{return {id,status:'deleted',events:[]};}}); }
  cancel() { for (const id of this.jobs) {try{if(getJob(id).status === 'running') cancelJob(id);}catch{}} }
  async close() { this.cancel(); await Promise.all([...this.pending]); }
}
