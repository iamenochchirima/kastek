import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { createProductBindings,registerProductAdapter,registerProductManifest } from "../src/capabilities/products/product-capabilities";
import { productModelResult } from "../src/execution/products/product-result";
import { modelReceiptOutput } from "../src/execution/context/journal";
import { growthConnectionReadAdapterManifest,growthContentReadModelProjections,growthHistoricalModelProjections,growthRetainedOperationAdapters,growthFullOperationAccessHandlers,growthFullOperationHandlers } from "../src/adapters/products/growth-capability-manifests";
import { growthAgentPublicationV13,growthAgentPublicationV9 } from "../../../growth/api/src/agents/manifest";

it("keeps signed media URLs out of current and retained model views, including history chunks",()=>{
  registerProductAdapter(growthConnectionReadAdapterManifest,{handlers:growthFullOperationHandlers,accessReceiptHandlers:growthFullOperationAccessHandlers,
    modelProjections:growthContentReadModelProjections,invoke:async()=>({value:{}})});
  const retained=growthRetainedOperationAdapters.find(value=>value.manifest.release==="6")!;
  registerProductAdapter(retained.manifest,{handlers:retained.handlers,
    accessReceiptHandlers:growthFullOperationAccessHandlers.filter(handler=>(retained.handlers as readonly string[]).includes(handler)),
    modelProjections:Object.fromEntries(Object.entries(growthHistoricalModelProjections).filter(([handler])=>(retained.handlers as readonly string[]).includes(handler))),invoke:async()=>({value:{}})});
  const bindings=[growthAgentPublicationV13,growthAgentPublicationV9].map(publication=>{
    const manifest=registerProductManifest(publication.manifest);
    return createProductBindings(manifest,randomUUID(),{originProduct:"growth",originTenantId:"tenant",tenantId:"tenant",mappingRef:"growth:org",policyRevision:publication.policy.revision},["content.media.preview"])[0]!;
  });
  for(const binding of bindings){
    const original={value:{state:"succeeded",result:{asset:{id:"asset-1",kind:"IMAGE",mimeType:"image/png",fileName:"banner.png"},previewUrl:"https://media.test/?signature=private"}}};
    const before=structuredClone(original),view=productModelResult(binding,original,randomUUID(),"operation");
    expect(view).toEqual({value:{state:"succeeded",result:{asset:{id:"asset-1",kind:"IMAGE",mimeType:"image/png",fileName:"banner.png"},previewReady:true}}});
    expect(original).toEqual(before);
    for(const chunk of ['{"result":{"previewUrl":"https://media.test/?sign','ature=private"}}']){
      const row={id:"operation",name:binding.alias,state:"completed",request:{productBindingId:binding.id,bindingDigest:binding.digest},
        output:{value:{state:"succeeded",result:{encoding:"json",chunk}}}};
      const execution={task:{id:randomUUID()},configuration:{productBindings:[binding]}};
      expect(modelReceiptOutput(execution as never,row)).toEqual({value:{state:"succeeded",result:{previewReady:true}}});
    }
  }
});
