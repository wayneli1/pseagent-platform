import {label} from "./labels.js";

export function h(value:unknown):string{return String(value??"").replace(/[&<>'"]/gu,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]!);}
export function time(value:string|undefined):string{if(!value)return"—";const date=new Date(value);return Number.isNaN(date.valueOf())?"—":new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(date);}
export function shortId(value:string|undefined,length=10):string{return value?value.slice(0,length):"—";}
export function badge(value:string):string{return`<span class="badge badge-${h(value.replaceAll("_","-"))}" title="技术状态：${h(value)}">${h(label(value))}</span>`;}
export function json(value:unknown):string{return h(JSON.stringify(value,null,2));}
