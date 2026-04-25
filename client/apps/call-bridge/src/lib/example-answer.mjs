export function exampleAnswerSdp() {
  return [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=KasiTek Call Bridge Stub",
    "t=0 0",
    "a=msid-semantic: WMS",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "c=IN IP4 0.0.0.0",
    "a=rtcp:9 IN IP4 0.0.0.0",
    "a=ice-ufrag:stub",
    "a=ice-pwd:stubpassword",
    "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
    "a=setup:active",
    "a=mid:0",
    "a=sendrecv",
    "a=rtpmap:111 opus/48000/2",
    "",
  ].join("\r\n");
}
