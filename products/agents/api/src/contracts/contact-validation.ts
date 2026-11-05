/** Format check only; it does not prove the customer controls the number. */
export function validContactPhone(value:string):boolean {
  const trimmed=value.trim();
  const digits=trimmed.replace(/[^0-9]/g,"");
  return /^[+()0-9 .-]+$/.test(trimmed) && digits.length>=7 && digits.length<=15;
}
