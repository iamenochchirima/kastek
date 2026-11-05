import { expect,it } from "vitest";
import { legacyControlPrefix } from "../src/execution/context/legacy-control-prefix";

it("extracts complete typed legacy selector tokens from a truncated JSON prefix",()=>{
  const prefix='{"result":{"connections":[{"id":"external_connection_12345","displayName":"contains \\"id\\": \\"fake\\"","externalAccountId":"page_1234\\u0035"},{"id":"unfinished';
  expect(legacyControlPrefix(prefix,"connections.list")).toEqual(["external_connection_12345","page_12345"]);
  expect(legacyControlPrefix(prefix,"content.accounts.list")).toEqual([]);
  expect(legacyControlPrefix('{"result":{"accounts":[{"id":"social_account_123456","external_account_id":"provider_account_123456"',"content.accounts.list"))
    .toEqual(["social_account_123456","provider_account_123456"]);
});
