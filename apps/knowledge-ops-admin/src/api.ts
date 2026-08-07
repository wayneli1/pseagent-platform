import type {ListPage} from "./types.js";

export class ApiError extends Error { constructor(readonly status:number,readonly code:string){super(code);this.name="ApiError";} }
export interface LoginSession {readonly sessionToken:string;readonly expiresAt:string;readonly user:{readonly username:string};}
export class OpsApiClient {
  constructor(private token:string){}
  setSessionToken(token:string){this.token=token;}
  login(username:string,password:string){return this.request<LoginSession>("POST","/v1/auth/login",{username,password},false);}
  logout(){return this.request<{status:string}>("POST","/v1/auth/logout",{});}
  get<T>(path:string){return this.request<T>("GET",path);}
  async getPage<T>(path:string,offset:number,limit:number,legacyFilter?:(item:T)=>boolean):Promise<ListPage<T>>{
    const value=await this.request<unknown>("GET",path);
    if(Array.isArray(value)){const items=legacyFilter?(value as T[]).filter(legacyFilter):value as T[];return{items:items.slice(offset,offset+limit),total:items.length};}
    if(value!==null&&typeof value==="object"&&Array.isArray((value as ListPage<T>).items)&&Number.isInteger((value as ListPage<T>).total)&&(value as ListPage<T>).total>=0)return value as ListPage<T>;
    throw new ApiError(502,"invalid_paginated_response");
  }
  post<T>(path:string,body:unknown={}){return this.request<T>("POST",path,body);}
  patch<T>(path:string,body:unknown){return this.request<T>("PATCH",path,body);}
  private async request<T>(method:string,path:string,body?:unknown,authenticated=true):Promise<T>{
    let response:Response;
    try{response=await fetch(path,{method,signal:AbortSignal.timeout(12_000),headers:{...(authenticated&&this.token?{authorization:`Bearer ${this.token}`}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch(error){if(error instanceof DOMException&&error.name==="TimeoutError")throw new ApiError(503,"management_service_timeout");throw new ApiError(503,"management_service_unavailable");}
    let value:unknown;try{value=await response.json();}catch{value={error:"invalid_server_response"};}
    if(!response.ok){const code=typeof value==="object"&&value!==null&&"error" in value?String((value as {error:unknown}).error):"request_failed";throw new ApiError(response.status,code);}return value as T;
  }
}
