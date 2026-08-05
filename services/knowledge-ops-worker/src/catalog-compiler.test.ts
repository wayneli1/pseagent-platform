import path from "node:path";
import { describe,expect,it } from "vitest";
import { CatalogCompiler } from "./catalog-compiler.js";

it("compiles approved cards and automatic question families from both real knowledge bases",async()=>{const workspace=path.resolve(import.meta.dirname,"../../../..");const catalog=await new CatalogCompiler().compile([{domain:"coremail-professional",root:path.join(workspace,"coremail-professional")},{domain:"presales-general",root:path.join(workspace,"presales-general")}]);expect(catalog.cards.filter(x=>x.domain==="coremail-professional")).toHaveLength(6);expect(catalog.cards.filter(x=>x.domain==="presales-general")).toHaveLength(7);expect(catalog.domains).toHaveLength(2);expect(catalog.families).toHaveLength(13);expect(new Set(catalog.families.map(family=>family.familyId))).toHaveProperty("size",13);expect(catalog.families.every(family=>family.bindings.length>0)).toBe(true);});
