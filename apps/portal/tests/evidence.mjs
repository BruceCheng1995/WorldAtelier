// Tickets are ephemeral credentials, even after consumption. Keep useful runtime
// and server URLs in evidence while removing ticket fields/query values.
export function redactEvidence(value){
  if(typeof value==='string')return value.replace(/([?&]ticket=)[^&#\s"']+/gi,'$1[redacted]')
  if(Array.isArray(value))return value.map(redactEvidence)
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(ticket|token|authorization|host_key)$/i.test(key)?'[redacted]':redactEvidence(item)]))
  return value
}
