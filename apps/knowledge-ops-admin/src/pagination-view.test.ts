import {describe,expect,it} from "vitest";
import {paginationView} from "./pagination-view.js";

describe("分页展示",()=>{
  it("计算首尾记录与翻页状态",()=>{expect(paginationView(61,25,25,25)).toEqual({start:26,end:50,hasPrevious:true,hasNext:true});});
  it("空列表不显示虚假的第一条",()=>{expect(paginationView(0,0,0,25)).toEqual({start:0,end:0,hasPrevious:false,hasNext:false});});
  it("最后一页禁用下一页",()=>{expect(paginationView(61,50,11,25)).toEqual({start:51,end:61,hasPrevious:true,hasNext:false});});
});
