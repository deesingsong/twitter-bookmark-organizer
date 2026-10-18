"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseSearchQuery } from "@/lib/search/query";
import { EmbeddingIndexer, initialEmbeddingIndexingState, LocalEmbeddingClient, type EmbeddingModelStatus } from "@/lib/embeddings/indexing-client";
import { EMBEDDING_CONTRACT } from "@/lib/embeddings/contracts";

type Item = { id:string; canonicalUrl:string|null; text:string|null; note:string|null; authorUsername:string|null; authorDisplayName:string|null; tweetCreatedAt:string|null; hasMedia:boolean; matchKind:"exact"|"literal"|"lexical"|"metadata"|"approximate"|"semantic"|"hybrid"|null; mediaReferences:{type:string;url?:string|null;previewUrl?:string|null;videoUrl?:string|null}[]; quotedTweet:{text?:string|null;canonicalUrl?:string|null;authorUsername?:string|null;authorDisplayName?:string|null} | null; tags:{id:string;name:string}[]; collections:{id:string;name:string}[] };
type Org = { tags:{id:string;name:string}[]; collections:{id:string;name:string}[] };
async function api<T>(url:string, init?:RequestInit):Promise<T>{const r=await fetch(url,{...init,cache:"no-store",headers:{...(init?.body?{"content-type":"application/json"}:{}),...init?.headers}}); const data=await r.json() as T & {error?:string}; if(!r.ok)throw new Error(data.error||"failed");return data;}
const post=(body:unknown):RequestInit=>({method:"POST",body:JSON.stringify(body)});
const link=(value:string|null|undefined)=>value&&/^https?:\/\//i.test(value)?value:null;
const date=(v:string|null)=>v?new Intl.DateTimeFormat(undefined,{dateStyle:"medium"}).format(new Date(v)):"Date unavailable";
function highlighted(value:string|null,query:string){if(!value)return value;const parsed=parseSearchQuery(query);const terms=[...parsed.terms,...parsed.phrases,...parsed.literals,...parsed.handles.map(x=>`@${x}`),...parsed.hashtags.map(x=>`#${x}`)].filter(x=>x.length>1).sort((a,b)=>b.length-a.length);if(!terms.length)return value;const matcher=new RegExp(`(${terms.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})`,"giu");return value.split(matcher).map((part,index)=>terms.some(term=>term.toLocaleLowerCase()===part.toLocaleLowerCase())?<mark key={`${index}-${part}`}>{part}</mark>:part);}

export type LibrarySearchMode = "exact" | "hybrid" | "meaning";
export type LibrarySearchInput = {
 q: string; mode: LibrarySearchMode; consent: boolean; sort: string;
 author: string; from: string; to: string; media: string; tag: string; collection: string; cursor: string | null;
};
type LibraryPage = { bookmarks: Item[]; nextCursor: string | null };
type SearchOutcome = { page: LibraryPage; mode: LibrarySearchMode; semanticFailed: boolean; semanticFailureReason?: "contract_mismatch" | "unavailable"; semanticRestarted?: boolean };
type QueryVectorSession = { promise: Promise<number[]> | null; vector: number[] | null; pending: boolean };

/** Owns the vector used by a cursor session and cancels obsolete browser work. */
export class LibrarySearchSession {
 private controller: AbortController | null = null;
 private sequence = 0;
 private key: string | null = null;
 private vectorSession: QueryVectorSession | null = null;
 private embeddings: LocalEmbeddingClient | null = null;
 constructor(private readonly onModelStatus: (status: EmbeddingModelStatus) => void = () => undefined) {}

 cancel() { this.sequence++; this.controller?.abort(); this.controller = null; }
 invalidate() {
  this.cancel();
  this.key = null;
  if (this.vectorSession?.pending) { this.embeddings?.dispose(); this.embeddings = null; }
  this.vectorSession = null;
 }
 dispose() { this.invalidate(); this.embeddings?.dispose(); this.embeddings = null; }

 private getVector(query: string, session: QueryVectorSession): Promise<number[]> {
  if (session.promise) return session.promise;
  session.pending = true;
  const attempt = (async () => {
   if (!this.embeddings) {
    const client = new LocalEmbeddingClient(status => { if (this.embeddings === client) this.onModelStatus(status); });
    this.embeddings = client;
   }
   const client = this.embeddings;
   await client.initialize();
   if (this.vectorSession !== session || this.embeddings !== client) throw new DOMException("Search cancelled", "AbortError");
   const vector = await client.embedQuery(query);
   session.vector = vector;
   return vector;
  })().finally(() => { session.pending = false; });
  session.promise = attempt;
  void attempt.catch(() => {
   if (session.promise === attempt) session.promise = null;
  });
  return attempt;
 }

 async search(input: LibrarySearchInput, preview?: (page: LibraryPage) => void): Promise<SearchOutcome> {
  const key = JSON.stringify({ ...input, cursor: null });
  if (key !== this.key) { this.invalidate(); this.key = key; }
  this.cancel();
  const sequence = this.sequence;
  const controller = new AbortController();
  this.controller = controller;
  const current = () => sequence === this.sequence && !controller.signal.aborted;
  const assertCurrent = () => { if (!current()) throw new DOMException("Search cancelled", "AbortError"); };
  const query = input.q.trim().normalize("NFC");
  const parameters: Record<string, string | number> = { limit: 20, sort: input.sort };
  if (query) parameters.q = query;
  for (const field of ["author", "from", "to", "tag", "collection"] as const) if (input[field]) parameters[field] = input[field];
  if (input.media !== "any") parameters.media = input.media;
  const lexical = (cursor: string | null) => {
   const params = new URLSearchParams(Object.entries(parameters).map(([name, value]) => [name, String(value)]));
   if (cursor) params.set("cursor", cursor);
   return api<LibraryPage>(`/api/bookmarks?${params}`, { signal: controller.signal });
  };
  try {
   if (!query || input.mode === "exact" || !input.consent) {
    const page = await lexical(input.cursor);
    assertCurrent();
    return { page, mode: "exact", semanticFailed: false };
   }
   const session = this.vectorSession ??= { promise: null, vector: null, pending: false };
   let semanticFinished = false;
   // Exact results stay usable while the opt-in model downloads/prepares.
   const exactPreview = session.vector ? null : lexical(null).then(page => {
    if (current() && !semanticFinished) preview?.({ ...page, nextCursor: null });
    return page;
   }).catch(() => null);
   try {
    const vector = await this.getVector(query, session);
    assertCurrent();
    const semanticBody = { ...parameters, q: query, mode: input.mode, contract: EMBEDDING_CONTRACT, queryVector: vector };
    let page: LibraryPage;
    let semanticRestarted = false;
    try {
     page = await api<LibraryPage>("/api/bookmarks/search", {
      ...post({ ...semanticBody, ...(input.cursor ? { cursor: input.cursor } : {}) }),
      signal: controller.signal,
     });
    } catch (error) {
     if (!input.cursor || !(error instanceof Error) || error.message !== "invalid_cursor") throw error;
     assertCurrent();
     page = await api<LibraryPage>("/api/bookmarks/search", { ...post(semanticBody), signal: controller.signal });
     semanticRestarted = true;
    }
    assertCurrent();
    semanticFinished = true;
    return { page, mode: input.mode, semanticFailed: false, semanticRestarted };
   } catch (error) {
    semanticFinished = true;
    assertCurrent();
    const page = await exactPreview ?? await lexical(null);
    assertCurrent();
    return { page, mode: "exact", semanticFailed: true, semanticFailureReason: error instanceof Error && error.message === "embedding_contract_mismatch" ? "contract_mismatch" : "unavailable" };
   }
  } finally {
   if (this.controller === controller) this.controller = null;
  }
 }
}

function EmbeddingIndexingPanel() {
 const [consent, setConsent] = useState(false);
 const [state, setState] = useState(initialEmbeddingIndexingState);
 const indexer = useRef<EmbeddingIndexer | null>(null);
 useEffect(() => {
  const client = new EmbeddingIndexer(setState);
  indexer.current = client;
  void client.refreshStatus();
  return () => { client.dispose(); indexer.current = null; };
 }, []);
 const indexing = state.phase === "starting" || state.phase === "running" || state.phase === "pausing";
 const active = indexing || state.phase === "retrying";
 const phaseText = {
  idle: "Local indexing has not started.",
  retrying: "Returning failed bookmarks to the pending index before starting.",
  starting: "Preparing the local model. The first download may take a few minutes.",
  running: "Indexing one bookmark at a time on this device.",
  pausing: "Pausing after the current bookmark or model download finishes.",
  paused: "Indexing is paused. Finished work is saved.",
  complete: "No bookmarks are available to index right now. Check again after imports or edits.",
  error: "Indexing has stopped. Keyword search remains available.",
 }[state.phase];
 const startLabel = state.phase === "paused" ? "Resume local indexing" : state.phase === "error" ? "Resume pending indexing" : state.phase === "complete" ? "Check for pending bookmarks" : "Start local indexing";
 function start() {
  if (!consent) return;
  indexer.current ??= new EmbeddingIndexer(setState);
  void indexer.current.start();
 }
 return <details className="mb-6 border border-[var(--line)] bg-white/40 p-4 text-sm">
  <summary className="cursor-pointer font-medium">Local meaning index (optional){state.counts && <span className="ml-2 text-xs font-normal text-[var(--muted)]">{state.counts.ready}/{state.counts.total} indexed</span>}</summary>
  <div className="mt-4 grid gap-4">
   <p id="local-index-description" className="m-0 max-w-2xl leading-relaxed text-[var(--muted)]">Download the English BGE-small model and its runtime to this browser. Model assets may stay in browser storage for reuse. Your device processes post text, quotes, notes and tags locally; vectors are saved to your private library. Building the index uses memory and battery. Keep this tab open while it runs.</p>
   <p className="m-0 text-xs leading-relaxed text-[var(--muted)]">This English model may give poor results in other languages. Exact and keyword search remain available if the model cannot run. Closing this tab keeps finished work; unfinished work becomes available again after a short wait.</p>
   <div className="grid gap-2 border-y border-[var(--line)] py-3 text-xs">
    {state.counts ? <><p className="m-0 font-medium">{state.counts.ready} of {state.counts.total} bookmarks indexed</p><progress className="h-2 w-full max-w-md accent-[var(--green)]" aria-label="Bookmarks indexed" max={Math.max(1, state.counts.total)} value={state.counts.ready}/><p className="m-0 leading-relaxed text-[var(--muted)]">Pending: {state.counts.pending} · Processing: {state.counts.processing} · Stale: {state.counts.stale} · Failed: {state.counts.failed}</p></> : <p className="m-0">{state.statusError ? "Index counts are unavailable." : "Loading index counts…"}</p>}
    {state.statusError && <p className="m-0 text-[#8b342c]" role="status">{state.statusError}</p>}
    <button type="button" className="text-button justify-self-start" onClick={() => void indexer.current?.refreshStatus()}>Refresh index counts</button>
   </div>
   <label className="flex items-start gap-3 leading-relaxed"><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--green)]" checked={consent} disabled={active} onChange={event => setConsent(event.target.checked)} aria-describedby="local-index-description"/><span>I agree to download and cache the local model and use this device to build my meaning index.</span></label>
   <div className="flex flex-wrap items-center gap-3">
    <button type="button" className="quiet-button" disabled={!consent || active} onClick={start}>{startLabel}</button>
    {indexing && <button type="button" className="quiet-button" disabled={state.phase === "pausing"} onClick={() => indexer.current?.pause()}>{state.phase === "pausing" ? "Pausing…" : "Pause indexing"}</button>}
    {!!state.counts?.failed && <button type="button" className="quiet-button" disabled={!consent || active} onClick={() => void indexer.current?.retryFailed(Math.min(10, state.counts!.failed))}>Retry {Math.min(10, state.counts.failed)} failed bookmark{state.counts.failed === 1 ? "" : "s"}</button>}
   </div>
   {!!state.counts?.failed && <p className="m-0 text-xs leading-relaxed text-[var(--muted)]">Failed bookmarks need an explicit retry. The retry button returns up to 10 to the pending index and starts local indexing.</p>}
   <div role="status" aria-live="polite" aria-atomic="true" className="grid gap-2 text-xs text-[var(--muted)]">
    <p className="m-0">{phaseText}</p>
    <p className="m-0">{state.model.backend ? `Backend: ${state.model.backend === "webgpu" ? "WebGPU" : "WASM (CPU)"}${state.model.fallback ? " · using the CPU fallback" : ""}.` : "The model downloads only after you start indexing."}</p>
   </div>
   {state.model.phase === "loading" && <label className="grid max-w-md gap-2 text-xs text-[var(--muted)]">Model download and preparation {state.model.downloadPercent !== null && `(${state.model.downloadPercent}%)`}<progress className="h-2 w-full accent-[var(--green)]" aria-label="Model download and preparation" max={100} value={state.model.downloadPercent ?? undefined}/></label>}
   <dl className="m-0 grid grid-cols-1 gap-3 min-[420px]:grid-cols-3 text-xs">
    <div><dt className="text-[var(--muted)]">Saved this tab</dt><dd className="m-0 mt-1 text-xl">{state.completed}</dd></div>
    <div><dt className="text-[var(--muted)]">Changed or expired attempts</dt><dd className="m-0 mt-1 text-xl">{state.superseded}</dd></div>
    <div><dt className="text-[var(--muted)]">Failed attempts</dt><dd className="m-0 mt-1 text-xl">{state.failed}</dd></div>
   </dl>
   {state.error && <p className="library-error m-0" role="alert">{state.error}</p>}
  </div>
 </details>;
}

export function BookmarkLibrary(){
 const [items,setItems]=useState<Item[]>([]),[org,setOrg]=useState<Org>({tags:[],collections:[]}),[cursor,setCursor]=useState<string|null>(null),[next,setNext]=useState<string|null>(null),[previous,setPrevious]=useState<(string|null)[]>([]),[selected,setSelected]=useState<string[]>([]),[detail,setDetail]=useState<Item|null>(null),[q,setQ]=useState(""),[searchQ,setSearchQ]=useState(""),[sort,setSort]=useState("relevance"),[author,setAuthor]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState(""),[media,setMedia]=useState("any"),[tag,setTag]=useState(""),[collection,setCollection]=useState(""),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [mode,setMode]=useState<LibrarySearchMode>("hybrid"),[semanticConsent,setSemanticConsent]=useState(false),[searchPreparing,setSearchPreparing]=useState(false),[effectiveMode,setEffectiveMode]=useState<LibrarySearchMode>("exact"),[fallbackNotice,setFallbackNotice]=useState("");
 const [searchModel,setSearchModel]=useState<EmbeddingModelStatus>({phase:"idle",backend:null,downloadPercent:null,fallback:false});
 const searchSession=useRef<LibrarySearchSession|null>(null), sequenceRef=useRef(0);
 useEffect(()=>{const timer=window.setTimeout(()=>setSearchQ(q),250);return()=>window.clearTimeout(timer);},[q]);
 useEffect(()=>()=>{sequenceRef.current++;searchSession.current?.dispose();searchSession.current=null;},[]);
 const load=useCallback(async()=>{
  if(q!==searchQ)return;
  const sequence=++sequenceRef.current;
  searchSession.current??=new LibrarySearchSession(setSearchModel);
  setLoading(true);setError("");setSearchPreparing(Boolean(searchQ.trim())&&mode!=="exact"&&semanticConsent);
  try{
   const result=await searchSession.current.search({q:searchQ,mode,consent:semanticConsent,sort,author,from,to,media,tag,collection,cursor},page=>{
    if(sequence===sequenceRef.current){setItems(page.bookmarks);setNext(null);setEffectiveMode("exact");setLoading(false);}
   });
   if(sequence===sequenceRef.current){
    setItems(result.page.bookmarks);setNext(result.page.nextCursor);setEffectiveMode(result.mode);
    if(result.semanticRestarted){setFallbackNotice("Your meaning results changed while paging. Results restarted from the first page.");setCursor(null);setPrevious([]);}
    if(result.semanticFailed){setFallbackNotice(result.semanticFailureReason==="contract_mismatch"?"The local embedding version changed. Switched to Exact search; reload the page before using Meaning again.":"Meaning search is unavailable. Switched to Exact fallback and kept your query and filters.");setMode("exact");setCursor(null);setPrevious([]);searchSession.current.invalidate();}
   }
  }catch(caught){if(sequence===sequenceRef.current&&!(caught instanceof DOMException&&caught.name==="AbortError"))setError("The library could not be loaded. Try again.");}
  finally{if(sequence===sequenceRef.current){setLoading(false);setSearchPreparing(false);}}
 },[q,searchQ,mode,semanticConsent,sort,author,from,to,media,tag,collection,cursor]);
 const loadOrg=useCallback(async()=>{try{setOrg(await api<Org>("/api/organize"));}catch{setError("Tags and collections could not be loaded.");}},[]);
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)void load();});return()=>{active=false;sequenceRef.current++;searchSession.current?.cancel();};},[load]); useEffect(()=>{void Promise.resolve().then(loadOrg);},[loadOrg]);
 async function act(fn:()=>Promise<void>,message?:string){setBusy(true);setError("");try{await fn();if(message)setNotice(message);await load();await loadOrg();}catch{setError("The change could not be saved. Please try again.");}finally{setBusy(false);}}
 async function create(kind:"tag"|"collection"){const name=window.prompt(`Name for ${kind}:`);if(!name?.trim())return;await act(async()=>{await api("/api/organize",post({kind,name:name.trim()}));},`${kind} created.`);}
 async function manage(kind:"tag"|"collection",item:{id:string;name:string}){const choice=window.prompt(`Rename ${kind} (leave blank to delete):`,item.name);if(choice===null)return;if(!choice.trim()){if(!window.confirm(`Delete ${kind} “${item.name}”?`))return;await act(async()=>{await api(`/api/organize/${kind}/${item.id}`,{method:"DELETE",body:JSON.stringify({confirm:true})});},`${kind} deleted.`);return;}await act(async()=>{await api(`/api/organize/${kind}/${item.id}`,{method:"PATCH",body:JSON.stringify({name:choice.trim()})});},`${kind} renamed.`);}
 async function assign(item:Item,kind:"tag"|"collection",id:string,action:"add"|"remove"){await act(async()=>{await api(`/api/bookmarks/${item.id}/organize`,post({kind,id,action}));const source=kind==="tag"?org.tags:org.collections;const chosen=source.find(x=>x.id===id);setDetail(current=>{if(!current||current.id!==item.id||!chosen)return current;const key=kind==="tag"?"tags":"collections";const values=current[key]||[];return {...current,[key]:action==="add"?[...values,chosen]:values.filter(x=>x.id!==id)};});},"Organization updated.");}
 async function remove(ids:string[]){if(!window.confirm(`Delete ${ids.length} bookmark(s) and associated data? They may return on a later import.`))return;await act(async()=>{if(ids.length===1)await api(`/api/bookmarks/${ids[0]}`,{method:"DELETE",body:JSON.stringify({confirm:true})});else await api("/api/bookmarks/bulk-delete",post({confirm:true,ids}));setSelected([]);setDetail(null);},`${ids.length} bookmark(s) deleted.`);}
 async function open(item:Item){try{const r=await api<{bookmark:Item}>(`/api/bookmarks/${item.id}`);setDetail({...item,...r.bookmark});}catch{setError("Bookmark details could not be loaded.");}}
 function resetFilters(){sequenceRef.current++;searchSession.current?.invalidate();setCursor(null);setPrevious([]);setNext(null);setSearchPreparing(false);setFallbackNotice("");}
 function changeMode(value:LibrarySearchMode){resetFilters();setFallbackNotice("");setMode(value);}
 return <section className="library" aria-labelledby="library-title"><div className="library-heading"><div><p className="eyebrow">YOUR SAVED POSTS</p><h2 id="library-title">The library</h2></div><button className="quiet-button" onClick={()=>void create("collection")}>New collection</button></div>
 <EmbeddingIndexingPanel/>
 <fieldset className="mb-4 grid min-w-0 gap-3 border border-[var(--line)] p-4 text-sm" aria-describedby="meaning-search-explanation"><legend className="px-2">Search mode</legend><div className="flex flex-wrap gap-x-5 gap-y-3">{([['exact','Exact'],['hybrid','All'],['meaning','Meaning']] as const).map(([value,label])=><label key={value} className="flex min-h-8 cursor-pointer items-center gap-2"><input type="radio" name="search-mode" value={value} checked={mode===value} onChange={()=>changeMode(value)} className="h-4 w-4 accent-[var(--green)]"/>{label}</label>)}</div>
 <p id="meaning-search-explanation" className="m-0 max-w-2xl text-xs leading-relaxed text-[var(--muted)]">All combines keywords and meaning. Meaning finds related concepts. Enabling local search downloads an English model and runtime, and may cache model assets in this browser. Search text is processed on your device; its vector goes to your private library. Other languages may give poor results. Exact uses keywords without loading a model.</p>
 {mode!=="exact"&&<label className="flex items-start gap-3 text-xs leading-relaxed"><input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--green)]" checked={semanticConsent} onChange={event=>{resetFilters();setFallbackNotice("");setSemanticConsent(event.target.checked);}} aria-describedby="meaning-search-explanation"/><span>Enable local meaning search on this device</span></label>}
 <p className="m-0 text-xs leading-relaxed text-[var(--muted)]" role="status" aria-live="polite">{fallbackNotice||(mode!=="exact"&&!semanticConsent?"Exact fallback active. Enable local meaning search to use All or Meaning.":searchPreparing?"Exact fallback active while meaning search prepares.":!searchQ.trim()&&mode!=="exact"?"Enter a query to search with your selected mode.":effectiveMode==="hybrid"?"All search active: keyword and meaning results.":effectiveMode==="meaning"?"Meaning search active: conceptual results.":"Exact search active: keyword results.")}</p>
 {mode!=="exact"&&semanticConsent&&searchModel.backend&&<p className="m-0 text-xs text-[var(--muted)]">Local search backend: {searchModel.backend==="webgpu"?"WebGPU":"WASM (CPU)"}{searchModel.fallback?" · CPU fallback":""}</p>}
 {mode!=="exact"&&semanticConsent&&searchModel.phase==="loading"&&<progress className="h-2 w-full max-w-md accent-[var(--green)]" aria-label="Search model preparation" max={100} value={searchModel.downloadPercent??undefined}/>}
 </fieldset>
 <div className="filters"><label className="search-field">Search posts<input aria-label="Search posts" maxLength={300} value={q} onChange={e=>{resetFilters();setQ(e.target.value);}} placeholder="Words, @username, #tag, phrase, or tweet URL"/></label><label>Sort<select aria-label="Search sort" value={sort} onChange={e=>{setSort(e.target.value);resetFilters();}}><option value="relevance">Relevance</option><option value="newest">Newest</option></select></label><label>Author<input aria-label="Filter author" value={author} onChange={e=>{setAuthor(e.target.value);resetFilters();}} placeholder="Name or username"/></label><label>From<input aria-label="From date" type="date" value={from} onChange={e=>{setFrom(e.target.value);resetFilters();}}/></label><label>To<input aria-label="To date" type="date" value={to} onChange={e=>{setTo(e.target.value);resetFilters();}}/></label><label>Media<select aria-label="Media filter" value={media} onChange={e=>{setMedia(e.target.value);resetFilters();}}><option value="any">Any</option><option value="yes">With media</option><option value="no">Without media</option></select></label><label>Tag<select aria-label="Tag filter" value={tag} onChange={e=>{setTag(e.target.value);resetFilters();}}><option value="">All tags</option>{org.tags.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>Collection<select aria-label="Collection filter" value={collection} onChange={e=>{setCollection(e.target.value);resetFilters();}}><option value="">All collections</option>{org.collections.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><button className="quiet-button" onClick={()=>void load()}>Apply</button></div>
 {error&&<p className="library-error" role="alert">{error} <button className="text-button" onClick={()=>void load()}>Retry</button></p>}{notice&&<p role="status" className="library-notice">{notice}</p>}
 <div className="library-toolbar"><span>{loading?"Loading bookmarks…":`${items.length} bookmarks`}</span><button className="text-button" onClick={()=>void create("tag")}>+ New tag</button><button className="text-button" onClick={()=>void create("collection")}>+ New collection</button>{selected.length>0&&<button className="danger-button" disabled={busy} onClick={()=>void remove(selected)}>Delete {selected.length} selected</button>}</div>
 {(org.tags.length>0||org.collections.length>0)&&<div className="organizer-manage"><span>Manage:</span>{org.tags.map(x=><button className="text-button" key={`tag-${x.id}`} onClick={()=>void manage("tag",x)}>tag: {x.name}</button>)}{org.collections.map(x=><button className="text-button" key={`collection-${x.id}`} onClick={()=>void manage("collection",x)}>collection: {x.name}</button>)}</div>}
 {loading?<p className="library-state" role="status">Loading your library…</p>:!error&&!items.length?<div className="library-state"><h3>No bookmarks found</h3><p>Import an archive above or adjust your filters.</p></div>:<div className="bookmark-list">{items.map(item=><article className="bookmark-card" key={item.id}><input type="checkbox" aria-label="Select bookmark" checked={selected.includes(item.id)} onChange={e=>setSelected(s=>e.target.checked?[...s,item.id]:s.filter(x=>x!==item.id))}/><div className="tweet-body"><div className="tweet-byline"><strong>{item.authorDisplayName||item.authorUsername||"Unknown author"}</strong>{item.authorUsername&&<span>@{item.authorUsername}</span>}<time>{date(item.tweetCreatedAt)}</time></div><p className="tweet-text">{highlighted(item.text,searchQ)||"No post text was included in the archive."}</p>
 {item.quotedTweet&&<blockquote className="quoted-card"><p className="quote-label">Quoted post</p><p>{highlighted(item.quotedTweet.text||null,searchQ)||"Quoted post text unavailable"}</p><span>{item.quotedTweet.authorDisplayName||item.quotedTweet.authorUsername||"Author unavailable"}</span>{link(item.quotedTweet.canonicalUrl)&&<a href={link(item.quotedTweet.canonicalUrl)!} target="_blank" rel="noopener noreferrer">Open quoted post ↗</a>}</blockquote>}
 {!!item.mediaReferences?.length&&<ul className="media-list" aria-label="Media references">{item.mediaReferences.map((m,i)=><li key={`${m.type}-${i}`}><span>{m.type}</span>{link(m.url||m.previewUrl||m.videoUrl)?<a href={link(m.url||m.previewUrl||m.videoUrl)!} target="_blank" rel="noopener noreferrer">Open media reference ↗</a>:"Reference unavailable"}</li>)}</ul>}
 <div className="card-bottom"><div className="chips">{item.matchKind&&<span className="match-kind" aria-label={`Match type: ${item.matchKind}`}>{item.matchKind}</span>}{item.tags?.map(x=><span className="chip" key={x.id}>{x.name}</span>)}{item.collections?.map(x=><span className="chip collection-chip" key={x.id}>{x.name}</span>)}</div><div className="card-actions"><button className="text-button" onClick={()=>void open(item)}>Details</button>{link(item.canonicalUrl)&&<a href={link(item.canonicalUrl)!} target="_blank" rel="noopener noreferrer">Open on X ↗</a>}<button className="text-button delete-link" onClick={()=>void remove([item.id])}>Delete</button></div></div></div></article>)}</div>}
 <nav className="pagination" aria-label="Bookmark pages"><button className="quiet-button" disabled={!previous.length||loading||searchPreparing} onClick={()=>{setCursor(previous.at(-1)||null);setPrevious(x=>x.slice(0,-1));}}>Newer</button><span>{searchQ&&sort==="relevance"?"Search relevance · stable results":"Newest first"}</span><button className="quiet-button" disabled={!next||loading||searchPreparing} onClick={()=>{setPrevious(x=>[...x,cursor]);setCursor(next);}}>Older</button></nav>
 {detail&&<div className="dialog-backdrop"><section className="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="detail-heading"><header className="detail-heading"><h2 id="detail-heading">Bookmark details</h2><button className="text-button" onClick={()=>setDetail(null)}>Close</button></header><p>{detail.authorDisplayName||detail.authorUsername} · {date(detail.tweetCreatedAt)}</p><p className="detail-text">{detail.text}</p><label className="note-label">Personal note<textarea id="bookmark-note" key={detail.id} defaultValue={detail.note||""} maxLength={10000} rows={4}/></label><button className="quiet-button" disabled={busy} onClick={()=>void act(async()=>{const note=(document.getElementById("bookmark-note") as HTMLTextAreaElement).value;await api(`/api/bookmarks/${detail.id}`,{method:"PATCH",body:JSON.stringify({note})});setDetail({...detail,note:note.trim()||null});},"Note saved.")}>Save note</button>
 <div className="detail-organize"><section><h3>Tags</h3>{org.tags.map(x=><label className="organize-option" key={x.id}><input type="checkbox" checked={detail.tags?.some(y=>y.id===x.id)||false} onChange={e=>void assign(detail,"tag",x.id,e.target.checked?"add":"remove")}/>{x.name}</label>)}<button className="text-button" onClick={()=>void create("tag")}>+ Create tag</button></section><section><h3>Collections</h3>{org.collections.map(x=><label className="organize-option" key={x.id}><input type="checkbox" checked={detail.collections?.some(y=>y.id===x.id)||false} onChange={e=>void assign(detail,"collection",x.id,e.target.checked?"add":"remove")}/>{x.name}</label>)}<button className="text-button" onClick={()=>void create("collection")}>+ Create collection</button></section></div><button className="danger-button" onClick={()=>void remove([detail.id])}>Delete bookmark</button></section></div>}
 </section>;
}
