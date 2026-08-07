export interface PaginationView {
  readonly start: number;
  readonly end: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export function paginationView(total:number,offset:number,itemCount:number,pageSize:number):PaginationView {
  return {
    start: total===0?0:offset+1,
    end: Math.min(total,offset+itemCount),
    hasPrevious: offset>0,
    hasNext: offset+pageSize<total,
  };
}

export function boundedPageOffset(total:number,offset:number,pageSize:number):number {
  if(total<=0)return 0;
  return Math.min(Math.max(0,offset),Math.floor((total-1)/pageSize)*pageSize);
}
