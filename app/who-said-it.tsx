"use client";

import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";

type Chatter = { id:string; name:string; avatar:string; messages:number; sub:boolean; vip:boolean; mod:boolean; score:number; activeDays:number; activeMonths:number; avgWords:number };
type Quote = { id:string; author:string; text:string; emotes:{id:string;start:number;end:number;url?:string}[]; sentAt:number; quality:number; difficulty:"easy"|"medium"|"hard" };
type Round = Quote & { choices:string[] };

function shuffled<T>(items:T[]){const copy=[...items];for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]]}return copy}

function playAnswerSound(correct:boolean){
  try{
    const AudioContextClass=window.AudioContext;
    const context=new AudioContextClass();
    const notes=correct?[523.25,659.25,783.99]:[392,329.63,261.63];
    notes.forEach((frequency,index)=>{
      const oscillator=context.createOscillator();const gain=context.createGain();const start=context.currentTime+index*(correct?.1:.18);
      oscillator.type=correct?"sine":"triangle";oscillator.frequency.setValueAtTime(frequency,start);
      if(!correct)oscillator.frequency.exponentialRampToValueAtTime(frequency*.82,start+.26);
      gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(correct?.11:.075,start+.025);gain.gain.exponentialRampToValueAtTime(.001,start+(correct?.28:.32));
      oscillator.connect(gain);gain.connect(context.destination);oscillator.start(start);oscillator.stop(start+(correct?.3:.34));
    });
    setTimeout(()=>void context.close(),700);
  }catch{}
}

async function addBrowserSevenTv(quotes:Quote[],roomId:string){
  if(!/^\d+$/.test(roomId))return quotes;
  try{
    const response=await fetch(`https://api.7tv.app/v3/users/twitch/${roomId}`);
    if(!response.ok)return quotes;
    const payload=await response.json();
    const catalog=new Map<string,string>();
    for(const emote of payload?.emote_set?.emotes??[]){
      const host=emote?.data?.host?.url;
      if(typeof emote?.name==="string"&&typeof host==="string")catalog.set(emote.name,`${host.startsWith("//")?"https:":""}${host}/4x.webp`);
    }
    return quotes.map(quote=>{
      const emotes=[...(quote.emotes??[])];
      for(const match of quote.text.matchAll(/\S+/gu)){
        const url=catalog.get(match[0]);const start=match.index;
        if(url&&!emotes.some(emote=>start<=emote.end&&start+match[0].length-1>=emote.start))emotes.push({id:`7tv:${match[0]}`,start,end:start+match[0].length-1,url});
      }
      return {...quote,emotes:emotes.sort((a,b)=>a.start-b.start)};
    });
  }catch{return quotes}
}

function renderQuote(quote:Quote){
  if(!quote.emotes?.length)return quote.text;
  const parts=[];let cursor=0;
  for(const emote of quote.emotes){
    if(emote.start<cursor||emote.end>=quote.text.length)continue;
    if(emote.start>cursor)parts.push(quote.text.slice(cursor,emote.start));
    const name=quote.text.slice(emote.start,emote.end+1);
    parts.push(<span key={`${emote.id}-${emote.start}`} className="emote-with-label" tabIndex={0}><img className="chat-emote" src={emote.url??`https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/default/dark/3.0`} alt={name}/><span role="tooltip">{name}</span></span>);
    cursor=emote.end+1;
  }
  if(cursor<quote.text.length)parts.push(quote.text.slice(cursor));
  return parts;
}

function makeRounds(quotes:Quote[],chatters:Chatter[]){
  const scores=new Map(chatters.map(c=>[c.name,c.score]));
  const chatterMap=new Map(chatters.map(c=>[c.name,c]));
  const grouped=new Map<string,Quote[]>();
  for(const quote of shuffled(quotes)){const group=grouped.get(quote.author)??[];if(group.length<15){group.push(quote);grouped.set(quote.author,group)}}
  for(const group of grouped.values())group.sort((a,b)=>b.quality-a.quality);
  const candidates:Quote[]=[];let authors=shuffled([...grouped.keys()]);
  while(authors.length){const nextAuthors=shuffled(authors);for(const author of nextAuthors){const quote=grouped.get(author)?.shift();if(quote)candidates.push(quote)}authors=authors.filter(author=>(grouped.get(author)?.length??0)>0)}
  const rounds:Round[]=[];let previous="";
  for(const quote of candidates){
    if(quote.author===previous&&grouped.size>1)continue;
    const target=scores.get(quote.author)??0;
    const authorStyle=chatterMap.get(quote.author)?.avgWords??0;
    const close=chatters.filter(c=>c.name!==quote.author).sort((a,b)=>Math.abs(a.score-target)-Math.abs(b.score-target)).slice(0,10);
    const decoys=close.sort((a,b)=>Math.abs(b.avgWords-authorStyle)-Math.abs(a.avgWords-authorStyle));
    if(decoys.length<2)continue;
    rounds.push({...quote,choices:shuffled([quote.author,...shuffled(decoys).slice(0,2).map(c=>c.name)])});previous=quote.author;
  }
  return rounds;
}

export default function WhoSaidIt(){
  const [channel,setChannel]=useState("");const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  const [loadingProgress,setLoadingProgress]=useState(0);const [streamer,setStreamer]=useState<{name:string;logo:string}|null>(null);
  const [lookback,setLookback]=useState("365");const [mode,setMode]=useState<"unlimited"|"10">("unlimited");const [chatterPool,setChatterPool]=useState("50");
  const [rounds,setRounds]=useState<Round[]>([]);const [chatters,setChatters]=useState<Chatter[]>([]);const [range,setRange]=useState<{oldest:number;newest:number}|null>(null);
  const [index,setIndex]=useState(0);const [answered,setAnswered]=useState<string|null>(null);const [correct,setCorrect]=useState(0);
  const current=rounds[index];const avatars=useMemo(()=>new Map(chatters.map(c=>[c.name,c.avatar])),[chatters]);

  useEffect(()=>{const credit=document.createElement("a");credit.className="creator-credit";credit.href="https://www.twitch.tv/haruzzz";credit.target="_blank";credit.rel="noreferrer";credit.setAttribute("aria-label","Haruzzz on Twitch");credit.innerHTML='<span aria-hidden="true">T</span>Made by <strong>Haruzzz</strong>';document.body.appendChild(credit);return()=>credit.remove()},[]);

  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(!current)return;if(["1","2","3"].includes(event.key)&&!answered)answer(current.choices[Number(event.key)-1]);if((event.key==="Enter"||event.key===" ")&&answered)next()};addEventListener("keydown",key);return()=>removeEventListener("keydown",key)},[current,answered]);
  useEffect(()=>{if(!current||!channel)return;const key=`knowthechat-seen:${channel}`;let seen:string[]=[];try{seen=JSON.parse(localStorage.getItem(key)||"[]")}catch{}if(!seen.includes(current.id)){seen.push(current.id);localStorage.setItem(key,JSON.stringify(seen.slice(-500))) }},[current,channel]);

  async function load(event:FormEvent){event.preventDefault();setLoading(true);setLoadingProgress(4);setStreamer(null);setError("");const requestedChannel=channel.trim().toLowerCase().replace(/^@/,"");const timer=window.setInterval(()=>setLoadingProgress(value=>value<28?value+3:value<62?value+2:value<89?value+1:value),520);const profilePromise=fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(requestedChannel)}`).then(response=>response.ok?response.json():[]).then(users=>{const user=users?.[0];if(user?.logo)setStreamer({name:user.displayName??requestedChannel,logo:user.logo})}).catch(()=>{});try{const response=await fetch("/api/public-archive",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channel:requestedChannel,rangeDays:lookback,chatterPool:Number(chatterPool)})});const data=await response.json();if(!response.ok){setError(data.error??"Could not load this archive.");return}setLoadingProgress(91);const enriched=await addBrowserSevenTv(data.quotes??[],data.roomId??"");setLoadingProgress(97);await profilePromise;let seen:string[]=[];try{seen=JSON.parse(localStorage.getItem(`knowthechat-seen:${data.channel}`)||"[]")}catch{}const freshQuotes=enriched.filter((quote:Quote)=>!seen.includes(quote.id));const freshRounds=makeRounds(freshQuotes,data.chatters??[]);const freshIds=new Set(freshRounds.map(round=>round.id));const replayRounds=makeRounds(enriched,data.chatters??[]).filter(round=>!freshIds.has(round.id));const available=[...freshRounds,...replayRounds];const built=mode==="10"?available.slice(0,10):available;if(built.length<3){setError("That archive does not have enough distinct, recognizable messages in the selected period.");return}setLoadingProgress(100);await new Promise(resolve=>setTimeout(resolve,260));setChannel(data.channel);setChatters(data.chatters);setRange(data.range);setRounds(built);setIndex(0);setCorrect(0);setAnswered(null)}finally{window.clearInterval(timer);setLoading(false)}}
  function answer(name:string){if(answered||!name)return;const isCorrect=name===current.author;setAnswered(name);playAnswerSound(isCorrect);if(isCorrect)setCorrect(v=>v+1)}
  function next(){setAnswered(null);setIndex(v=>v+1)}
  function reset(){setRounds([]);setIndex(0);setAnswered(null);setCorrect(0)}

  const loadingStage=loadingProgress<25?"Opening the public archive":loadingProgress<55?"Sampling chat across the timeline":loadingProgress<78?"Ranking recognizable chatters":loadingProgress<92?"Selecting the strongest clues":loadingProgress<100?"Loading channel emotes":"Case file ready";
  const lookbackLabel=({"30":"30 days","90":"3 months","365":"1 year","730":"2 years","1095":"3 years","all":"All available"} as Record<string,string>)[lookback]??"1 year";
  const poolLabel=({"25":"Core · top 25","50":"Balanced · top 50","100":"Wide · top 100"} as Record<string,string>)[chatterPool]??"Balanced · top 50";
  if(loading)return <main className="simple-shell"><section className="case-builder"><div className="case-portrait">{streamer?<img src={streamer.logo} alt={`${streamer.name} Twitch profile`}/>:<span>{channel.slice(0,2).toUpperCase()}</span>}<i style={{"--progress":`${loadingProgress*3.6}deg`} as CSSProperties}/></div><p className="eyebrow">BUILDING #{streamer?.name??channel}</p><h1>Preparing the case file</h1><div className="case-settings"><span>History · {lookbackLabel}</span><span>Chatters · {poolLabel}</span><span>Game · {mode==="10"?"10 questions":"Unlimited"}</span></div><p className="case-stage">{loadingStage}<span className="loading-dots">…</span></p><div className="case-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={loadingProgress}><span style={{width:`${loadingProgress}%`}}/></div><div className="case-progress-meta"><span>{loadingProgress}%</span><span>Messages → chatters → clues → emotes</span></div></section></main>;

  if(rounds.length>0&&index>=rounds.length)return <main className="simple-shell"><section className="simple-card end-card"><p className="eyebrow">CASE CLOSED</p><h1>{correct} / {rounds.length}</h1><p>You knew {channel}&apos;s chat.</p><button className="launch" onClick={reset}>Try another channel</button></section></main>;

  if(!current)return <main className="simple-shell"><section className="simple-card"><div className="brand-lockup logo-only"><img className="brand-logo" src="/logo.png" alt="Who Said It?"/></div><h1>How well do you know<br/>your chat?</h1><p className="simple-copy">Enter a Twitch channel. We’ll keep only distinctive messages from its most recognizable chatters and start the game.</p><form className="channel-form" onSubmit={load}><label htmlFor="channel">Twitch channel</label><div><span>#</span><input id="channel" value={channel} onChange={e=>setChannel(e.target.value)} placeholder="streamer_name" autoFocus/><button disabled={loading||channel.trim().length<3}>{loading?"Building game…":"Open the case →"}</button></div><section className="game-options"><label>Maximum lookback<select value={lookback} onChange={e=>setLookback(e.target.value)}><option value="30">Up to 30 days</option><option value="90">Up to 3 months</option><option value="365">Up to 1 year</option><option value="730">Up to 2 years</option><option value="1095">Up to 3 years</option><option value="all">All available</option></select></label><label>Chatter pool<select value={chatterPool} onChange={e=>setChatterPool(e.target.value)}><option value="25">Core · top 25</option><option value="50">Balanced · top 50</option><option value="100">Wide · top 100</option></select></label><label>Game length<select value={mode} onChange={e=>setMode(e.target.value as "unlimited"|"10")}><option value="unlimited">Unlimited</option><option value="10">10 questions</option></select></label></section></form>{error&&<p className="simple-error">{error}</p>}<p className="privacy-note">Public archives only · actual coverage depends on the channel archive · no Twitch connection</p></section></main>;

  const rangeText=range?`${new Date(range.oldest).toLocaleDateString()} – ${new Date(range.newest).toLocaleDateString()}`:"latest available archive";
  return <main className="game-shell"><div className="game-top"><button className="brand mini" onClick={reset} aria-label="Back to setup"><img className="brand-logo mini-logo" src="/logo.png" alt="Who Said It?"/></button><div className="game-channel">{streamer&&<img src={streamer.logo} alt=""/>}<div><strong>#{streamer?.name??channel}</strong><small>{rangeText} · ROUND {index+1}/{rounds.length} <span>•</span> {correct} CORRECT</small></div></div></div><section className={`game-card ${answered?answered===current.author?"answer-correct":"answer-wrong":""}`}><p className="eyebrow">PUBLIC CHAT · {new Date(current.sentAt).toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"})} · <span className={`difficulty ${current.difficulty}`}>{current.difficulty}</span></p><blockquote>“{renderQuote(current)}”</blockquote><p className="prompt">Who said it?</p><div className="choices">{current.choices.map((name,i)=><button key={name} onClick={()=>answer(name)} className={answered?name===current.author?"right":name===answered?"wrong":"dim":""}><span className="choice-avatar">{avatars.get(name)??name.slice(0,2).toUpperCase()}</span>{name}<span className="choice-key">{i+1}</span></button>)}</div>{answered&&<div className={answered===current.author?"result good result-action":"result bad result-action"}><button onClick={next}>{index+1===rounds.length?"See results →":"Next message →"}</button></div>}</section><p className="game-foot">Multi-date chatters · balanced authors · recognizable messages · no repeats</p></main>
}
