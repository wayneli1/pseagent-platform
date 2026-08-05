export class ApiError extends Error { constructor(readonly status:number,readonly code:string){super(code);this.name="ApiError";} }
export class OpsApiClient {
  constructor(private token:string){}
  setToken(token:string){this.token=token;}
  get<T>(path:string){return this.request<T>("GET",path);}
  post<T>(path:string,body:unknown={}){return this.request<T>("POST",path,body);}
  patch<T>(path:string,body:unknown){return this.request<T>("PATCH",path,body);}
  private async request<T>(method:string,path:string,body?:unknown):Promise<T>{const response=await fetch(path,{method,headers:{authorization:`Bearer ${this.token}`,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});let value:unknown;try{value=await response.json();}catch{value={error:"invalid_server_response"};}if(!response.ok){const code=typeof value==="object"&&value!==null&&"error" in value?String((value as {error:unknown}).error):"request_failed";throw new ApiError(response.status,code);}return value as T;}
}
