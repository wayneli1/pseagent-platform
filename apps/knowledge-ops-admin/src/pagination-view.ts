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
