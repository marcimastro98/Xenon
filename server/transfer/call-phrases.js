'use strict';
// The words in a notification that mean a call is ringing, that it is not, and that it is a
// video call, in the languages the apps use.

// Text that means "somebody is calling you", in the 11 languages the dashboard
// itself speaks — the user's OS and chat apps are overwhelmingly in one of
// them. Compared against a folded form of title+body (see foldText).
//
// Every phrase here has to be specific to a RING. "call" and "chiamata" alone
// are not: "missed call", "chiamata persa" and "call ended" would all match and
// each of those is the exact moment a card must NOT appear. So the misses are
// listed too and win over the hits (see NOT_RINGING).
const RING_PHRASES = [
  // en
  'incoming call', 'incoming video call', 'incoming audio call', 'incoming voice call',
  'is calling you', 'is calling', 'calling you', 'wants to talk',
  // it
  'chiamata in arrivo', 'chiamata vocale in arrivo', 'videochiamata in arrivo', 'ti sta chiamando',
  'sta chiamando', 'ti chiama',
  // es
  'llamada entrante', 'videollamada entrante', 'te esta llamando',
  'esta llamando', 'llamada de video entrante',
  // fr
  'appel entrant', 'appel vocal entrant', 'appel video entrant', 'vous appelle', 't appelle',
  // de
  'eingehender anruf', 'eingehender sprachanruf', 'eingehender videoanruf', 'ruft dich an', 'ruft an',
  // pt
  'chamada recebida', 'chamada a receber', 'esta a ligar', 'esta ligando',
  'videochamada recebida', 'recebendo chamada', 'a receber chamada', 'a receber videochamada',
  'chamada de video recebida',
  // nl
  'inkomende oproep', 'inkomende spraakoproep', 'inkomende video oproep', 'inkomend videogesprek', 'belt je', 'belt u',
  // ru
  'входящий вызов', 'входящий звонок', 'входящий голосовой звонок', 'входящий видеозвонок', 'звонит вам', 'вам звонит',
  // ja
  '着信', '通話の呼び出し', 'から電話',
  // ko
  '수신 전화', '전화가 왔습니다', '통화 요청', '전화 왔어요', '통화 수신',
  // zh
  '来电', '呼叫你', '视频通话邀请', '正在呼叫',
  // pl
  'przychodzące połączenie',
];

// Phrases that mean the call is OVER or never connected. Checked first: a
// "missed call" toast contains "call" in every language and is the single most
// common way a naive matcher raises a card for a call nobody can answer.
const NOT_RINGING = [
  // en
  'missed call', 'missed a call', 'call ended', 'call declined', 'you missed',
  'no answer', 'call back', 'voicemail', 'left a message',
  // it
  'chiamata persa', 'chiamata terminata', 'chiamata rifiutata', 'hai perso',
  'richiama', 'segreteria',
  // es
  'llamada perdida', 'llamada finalizada', 'llamada rechazada', 'buzon de voz',
  // fr
  'appel manque', 'appel termine', 'appel refuse', 'messagerie vocale',
  // de
  'verpasster anruf', 'anruf beendet', 'anruf abgelehnt', 'mailbox',
  // pt
  'chamada perdida', 'chamada terminada', 'chamada recusada', 'correio de voz',
  // nl
  'gemiste oproep', 'oproep beeindigd', 'oproep geweigerd', 'voicemail',
  // ru
  'пропущенный вызов', 'пропущенный звонок', 'вызов завершен', 'звонок завершен',
  // ja
  '不在着信', '通話終了', '着信を逃しました',
  // ko
  '부재중 전화', '통화 종료', '전화를 놓쳤',
  // zh
  '未接来电', '通话已结束', '已拒接',
];

// A video ring, so the card can pick the right verb and (for Teams) the right
// accept shortcut — Teams has one key for audio and a different one for video.
const VIDEO_PHRASES = [
  'video call', 'video', 'videochiamata', 'videollamada', 'videoanruf',
  'videochamada', 'videogesprek', 'wideo', 'видеозвонок', 'ビデオ通話', '영상 통화', '视频通话', '视频来电',
];

module.exports = { RING_PHRASES, NOT_RINGING, VIDEO_PHRASES };
