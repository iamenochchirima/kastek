import {describe,expect,it} from "vitest";
import {contactCreateSchema,contactCommandSchema,recordFieldsSchema} from "../src/contracts/customer-records";
const commandId="6b14f833-680d-42e4-b00c-c870d16bf3c7";
describe("customer contact input validation",()=>{
 it("trims valid contact input and rejects malformed emails and phone numbers",()=>{
  expect(contactCreateSchema.parse({commandId,name:" Alex ",email:" alex@example.test ",phone:" +27 11 123 4567 "})).toMatchObject({name:"Alex",email:"alex@example.test",phone:"+27 11 123 4567"});
  expect(contactCreateSchema.safeParse({commandId,email:"alexexample.test"}).success).toBe(false);
  expect(contactCommandSchema.safeParse({commandId,action:"correct",expectedRevision:"1",phone:"not a number"}).success).toBe(false);
  expect(contactCommandSchema.safeParse({commandId,action:"correct",expectedRevision:"1",email:null}).success).toBe(true);
 });
 it("does not reject historical customer records when reading",()=>{
  expect(recordFieldsSchema.parse({email:"legacy-invalid"})).toEqual({email:"legacy-invalid"});
 });
});
