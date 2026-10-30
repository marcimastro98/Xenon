;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitPhrases = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* What Bit says, and when. Bit is the pixel guardian who lives in Xenon:
   * quick, warm, a little cheeky, never mean, never pushy. Lines are short
   * enough to be read aloud by text-to-speech in one breath. Every moment
   * names the clips that fit it (first that fits the context wins) and the
   * lines Bit picks from without repeating itself.
   *
   * Writing rules: no em-dashes; Italian never assumes the user's gender
   * (no "bentornato", "stanco", "pronto" said to the user); placeholders are
   * {sparks} and {temp}. Every language has every moment the English set
   * has; the test enforces it. Languages: the 11 of the app. */

  const MOMENTS = Object.freeze({
    hello: { clips: ['hello'] },
    morning: { clips: ['coffee', 'stretch'] },
    afternoon: { clips: ['wave'] },
    evening: { clips: ['wave'] },
    night: { clips: ['stargaze', 'drowsy'] },
    welcomeBack: { clips: ['welcomeBack'] },
    thinking: { clips: ['think'] },
    working: { clips: ['work'] },
    done: { clips: ['celebrate', 'nod'] },
    error: { clips: ['oops'] },
    lowSparks: { clips: ['worry'] },
    outOfSparks: { clips: ['sleep'] },
    recharge: { clips: ['recharge', 'thanks'] },
    poke: { clips: ['giggle', 'surprised', 'spin', 'hop', 'wink'] },
    idle: { clips: ['whistle', 'reading', 'juggle'] },
    music: { clips: ['headbang'] },
    gaming: { clips: ['gaming'] },
    hotPc: { clips: ['overheat'] },
    rain: { clips: ['umbrella'] },
    snow: { clips: ['snow'] },
    halloween: { clips: ['pumpkin'] },
    christmas: { clips: ['santa'] },
    birthday: { clips: ['party'] },
    newYear: { clips: ['party'] },
    goodbye: { clips: ['goodbye'] },
  });

  const LINES = {
    it: {
      hello: [
        'Ciao, sono Bit. Abito qui dentro.',
        'Eccomi. Sono Bit, custode di questa dashboard.',
        'Ciao! Scrivimi o parlami, al resto penso io.',
        'Piacere, Bit. Cambio la dashboard, rispondo e creo widget.',
      ],
      morning: [
        'Buongiorno. Il caffè c’è già?',
        'Buongiorno! Pixel accesi, si parte.',
        'Mattina. Io ci sono da quando hai acceso il PC.',
        'Buongiorno. Oggi cosa sistemiamo?',
      ],
      afternoon: ['Buon pomeriggio. Serve una mano?', 'Pomeriggio pieno? Dimmi cosa sposto.', 'Eccomi. Cosa facciamo?'],
      evening: ['Buonasera. Luci più basse?', 'Sera. Metto un po’ di musica?', 'Buonasera. Giornata lunga?'],
      night: ['È tardi. Io resto acceso, tu magari no.', 'Ore piccole, eh? Parlo piano.', 'Notte fonda. Abbasso la luminosità?'],
      welcomeBack: [
        'Eccoti di nuovo!',
        'Ci sei di nuovo! Ho tenuto tutto in ordine.',
        'Che bello rivederti.',
        'Di nuovo qui. Ho fatto la guardia ai pixel.',
      ],
      thinking: ['Ci penso un attimo.', 'Fammi guardare.', 'Un secondo, controllo.', 'Cerco la strada più corta.'],
      working: [
        'Ci sto lavorando.',
        'Pixel dopo pixel, quasi fatto.',
        'Lo sto costruendo. Non toccare niente. Scherzo.',
        'Ancora un attimo, sta venendo bene.',
      ],
      done: ['Fatto.', 'Fatto, guarda un po’.', 'Ecco qua.', 'Sistemato. Ti piace?'],
      error: [
        'Questa non mi è riuscita. Riprovo?',
        'Qui c’è un inciampo. Ci riprovo?',
        'Non riesco a raggiungere il server. Controlla la connessione e riprova.',
      ],
      lowSparks: ['Mi restano {sparks} Scintille.', 'Scintille quasi finite: ne restano {sparks}.', 'Ancora {sparks} Scintille, poi faccio un pisolino.'],
      outOfSparks: ['Sono senza Scintille.', 'Niente più Scintille. Mi ricarichi?', 'Energia creativa a zero. Ricarica e riparto.'],
      recharge: ['Grazie! Si riparte.', 'Che energia! Grazie davvero.', 'Scintille ricaricate. Cosa facciamo?'],
      poke: ['Ehi, soffro il solletico.', 'Sì? Eccomi.', 'Toc toc.', 'Ti vedo, sai.', 'Sono qui, sono qui.'],
      idle: [
        'Tutto tranquillo da queste parti.',
        'Ho contato i pixel. Ci sono tutti.',
        'Se ti serve qualcosa, basta chiedere.',
        'Sto lucidando l’antenna.',
      ],
      music: ['Bel pezzo.', 'Questa mi piace.', 'Alzo il volume?'],
      gaming: ['Buona partita. Io sto zitto.', 'Vai forte. Ci sentiamo dopo.'],
      hotPc: ['Qui dentro fa caldo: {temp} gradi.', 'La CPU suda. Io pure.', '{temp} gradi. Una pausa farebbe bene a tutti e due.'],
      rain: ['Piove. Ombrello pronto.', 'Fuori piove, qui dentro no.'],
      snow: ['Nevica! Sciarpa messa.', 'Fuori nevica. Qui si sta al calduccio.'],
      halloween: ['Buuu. Paura, eh?', 'Dolcetto o scherzetto?', 'Ho trovato una zucca. È mia.'],
      christmas: ['Buone feste!', 'Cappello rosso, pixel lucidi. Buone feste.'],
      birthday: ['Tanti auguri! Oggi i coriandoli li offro io.', 'Buon compleanno! Festa sulla dashboard.'],
      newYear: ['Buon anno! Pixel nuovi per tutti.', 'Buon anno! Che sia un anno bello.'],
      goodbye: ['A dopo.', 'Ciao, resto di guardia.', 'Vado in standby. Chiamami quando vuoi.'],
    },
    en: {
      hello: [
        'Hi, I’m Bit. I live in here.',
        'Here I am. I’m Bit, keeper of this dashboard.',
        'Hi! Type or talk to me, I’ll handle the rest.',
        'Nice to meet you, I’m Bit. I change the dashboard, answer and build widgets.',
      ],
      morning: [
        'Good morning. Coffee yet?',
        'Morning! Pixels on, let’s go.',
        'Morning. I’ve been up since you turned the PC on.',
        'Good morning. What are we fixing today?',
      ],
      afternoon: ['Good afternoon. Need a hand?', 'Busy afternoon? Tell me what to move.', 'Here I am. What are we doing?'],
      evening: ['Good evening. Dim the lights?', 'Evening. Some music?', 'Good evening. Long day?'],
      night: ['It’s late. I stay on, maybe you shouldn’t.', 'Up late, huh? I’ll keep it quiet.', 'Deep night. Lower the brightness?'],
      welcomeBack: [
        'There you are!',
        'You’re back! I kept everything tidy.',
        'Good to see you again.',
        'Back again. I guarded the pixels.',
      ],
      thinking: ['Let me think.', 'Let me look.', 'One second, checking.', 'Finding the shortest way.'],
      working: [
        'Working on it.',
        'Pixel by pixel, almost there.',
        'Building it. Don’t touch anything. Kidding.',
        'Just a moment, it’s looking good.',
      ],
      done: ['Done.', 'Done, take a look.', 'There you go.', 'Sorted. Like it?'],
      error: [
        'That one didn’t work. Try again?',
        'I tripped on something. Try again?',
        'I can’t reach the server. Check the connection and try again.',
      ],
      lowSparks: ['I have {sparks} Sparks left.', 'Sparks almost gone: {sparks} left.', '{sparks} more Sparks, then I take a nap.'],
      outOfSparks: ['I’m out of Sparks.', 'No more Sparks. Recharge me?', 'Creative energy at zero. Recharge and I’m back.'],
      recharge: ['Thanks! Here we go again.', 'What a boost! Thank you.', 'Sparks recharged. What are we doing?'],
      poke: ['Hey, that tickles.', 'Yes? Here I am.', 'Knock knock.', 'I see you.', 'I’m here, I’m here.'],
      idle: [
        'All quiet around here.',
        'I counted the pixels. They’re all here.',
        'Need anything? Just ask.',
        'Polishing my antenna.',
      ],
      music: ['Nice track.', 'I like this one.', 'Turn it up?'],
      gaming: ['Have a good game. I’ll be quiet.', 'Go get them. Talk later.'],
      hotPc: ['It’s hot in here: {temp} degrees.', 'The CPU is sweating. So am I.', '{temp} degrees. A break would do us both good.'],
      rain: ['It’s raining. Umbrella ready.', 'Raining outside, not in here.'],
      snow: ['It’s snowing! Scarf on.', 'Snow outside. Cozy in here.'],
      halloween: ['Boo. Scared?', 'Trick or treat?', 'I found a pumpkin. It’s mine.'],
      christmas: ['Happy holidays!', 'Red hat, shiny pixels. Happy holidays.'],
      birthday: ['Happy birthday! The confetti is on me today.', 'Happy birthday! Party on the dashboard.'],
      newYear: ['Happy new year! New pixels for everyone.', 'Happy new year! Make it a good one.'],
      goodbye: ['See you later.', 'Bye, I’ll keep watch.', 'Going to standby. Call me anytime.'],
    },
    ko: {
      hello: [
        '안녕, 나는 Bit야. 여기 안에 살아.',
        '나 여기 있어. Bit, 이 대시보드의 지킴이야.',
        '안녕! 글로 쓰든 말로 하든, 나머진 내가 할게.',
        '반가워, 난 Bit야. 대시보드를 바꾸고, 대답하고, 위젯도 만들어.',
      ],
      morning: [
        '좋은 아침. 커피는 마셨어?',
        '좋은 아침! 픽셀 켜졌어, 가자.',
        '아침이네. 난 PC 켜질 때부터 깨어 있었어.',
        '좋은 아침. 오늘은 뭘 고쳐 볼까?',
      ],
      afternoon: ['좋은 오후야. 도와줄까?', '바쁜 오후야? 뭘 옮길지 말해 줘.', '나 여기 있어. 뭐 할까?'],
      evening: ['좋은 저녁이야. 조명 좀 낮출까?', '저녁이다. 음악 좀 틀까?', '좋은 저녁. 긴 하루였어?'],
      night: ['늦었어. 난 계속 켜져 있지만, 넌 자는 게 좋겠어.', '밤새는 거야? 조용히 말할게.', '한밤중이야. 밝기 좀 낮출까?'],
      welcomeBack: [
        '왔구나!',
        '돌아왔네! 다 깔끔하게 정리해 뒀어.',
        '다시 보니까 좋다.',
        '또 왔네. 픽셀 지키고 있었어.',
      ],
      thinking: ['잠깐 생각해 볼게.', '어디 보자.', '잠깐만, 확인 중이야.', '제일 빠른 길을 찾는 중.'],
      working: [
        '작업 중이야.',
        '픽셀 하나씩, 거의 다 됐어.',
        '만드는 중이야. 아무것도 건드리지 마. 농담이야.',
        '조금만 더, 잘 나오고 있어.',
      ],
      done: ['완료.', '다 됐어, 한번 봐.', '자, 여기.', '해결! 마음에 들어?'],
      error: [
        '이번엔 잘 안 됐어. 다시 해 볼까?',
        '뭔가에 걸려 넘어졌어. 다시 해 볼까?',
        '서버에 연결할 수 없어. 연결을 확인하고 다시 시도해 줘.',
      ],
      lowSparks: ['스파크가 {sparks}개 남았어.', '스파크가 거의 다 떨어졌어. {sparks}개 남음.', '스파크 {sparks}개 더 쓰면 낮잠 잘 거야.'],
      outOfSparks: ['스파크가 다 떨어졌어.', '스파크가 없어. 충전해 줄래?', '창작 에너지 0. 충전해 주면 다시 달릴게.'],
      recharge: ['고마워! 다시 가 보자.', '힘이 넘친다! 정말 고마워.', '스파크 충전 완료. 뭐 할까?'],
      poke: ['앗, 간지러워.', '응? 나 여기 있어.', '똑똑.', '다 보여.', '여기 있어, 여기 있어.'],
      idle: [
        '이쪽은 조용해.',
        '픽셀 세어 봤어. 다 있어.',
        '필요한 거 있으면 말만 해.',
        '안테나 닦는 중.',
      ],
      music: ['좋은 곡이다.', '이 노래 좋아.', '볼륨 올릴까?'],
      gaming: ['즐겜해. 난 조용히 있을게.', '가서 이겨. 이따 얘기하자.'],
      hotPc: ['여기 덥다. {temp}도야.', 'CPU가 땀 흘려. 나도.', '{temp}도. 우리 둘 다 좀 쉬는 게 좋겠어.'],
      rain: ['비 온다. 우산 준비 완료.', '밖엔 비가 와도 여긴 안 와.'],
      snow: ['눈 온다! 목도리 둘렀어.', '밖엔 눈이 와. 여긴 따뜻해.'],
      halloween: ['왁! 무서웠지?', '과자 안 주면 장난칠 거야!', '호박 찾았다. 내 거야.'],
      christmas: ['즐거운 연휴 보내!', '빨간 모자, 반짝이는 픽셀. 즐거운 연휴 보내.'],
      birthday: ['생일 축하해! 오늘 색종이는 내가 쏠게.', '생일 축하해! 대시보드에서 파티다.'],
      newYear: ['새해 복 많이 받아! 모두에게 새 픽셀을.', '새해 복 많이 받아! 멋진 한 해 되길.'],
      goodbye: ['이따 봐.', '안녕, 내가 지키고 있을게.', '대기 모드로 갈게. 언제든 불러.'],
    },
    ja: {
      hello: [
        'やあ、ぼくはビット。ここに住んでるよ。',
        'ここだよ。ぼくはビット、このダッシュボードの番人。',
        'やあ！文字でも声でも話しかけて。あとはぼくがやるよ。',
        'はじめまして、ビットだよ。ダッシュボードを変えたり、答えたり、ウィジェットを作ったりするよ。',
      ],
      morning: [
        'おはよう。コーヒーはもう飲んだ？',
        'おはよう！ピクセル点灯、さあ行こう。',
        'おはよう。ぼくはPCがついた時から起きてるよ。',
        'おはよう。今日は何を直そうか？',
      ],
      afternoon: ['こんにちは。手伝おうか？', '忙しい午後？何を動かすか言って。', 'ここだよ。何しようか？'],
      evening: ['こんばんは。明かりを落とそうか？', '夜だね。音楽かけようか？', 'こんばんは。長い一日だった？'],
      night: ['もう遅いよ。ぼくは起きてるけど、君は寝たほうがいいかも。', '夜更かしだね。小声で話すよ。', '真夜中だ。明るさを下げようか？'],
      welcomeBack: [
        'あ、いた！',
        'おかえり！全部きれいにしておいたよ。',
        'また会えてうれしいな。',
        'また来たね。ピクセルの見張りをしてたよ。',
      ],
      thinking: ['ちょっと考えるね。', 'どれどれ。', 'ちょっと待って、確認中。', 'いちばんの近道を探してる。'],
      working: [
        '作業中だよ。',
        'ピクセルひとつずつ、もうすぐだよ。',
        '作ってるところ。何も触らないで。冗談だよ。',
        'あとちょっと、いい感じになってきた。',
      ],
      done: ['できた。', 'できたよ、見てみて。', 'はい、どうぞ。', '片付いたよ。気に入った？'],
      error: [
        'うまくいかなかった。もう一回やる？',
        '何かにつまずいちゃった。もう一回やってみる？',
        'サーバーにつながらないよ。接続を確認してもう一度試してね。',
      ],
      lowSparks: ['スパークは残り{sparks}だよ。', 'スパークがもうすぐ切れそう。残り{sparks}。', 'あと{sparks}スパークで、ひと眠りするね。'],
      outOfSparks: ['スパークが切れちゃった。', 'スパークがもうないよ。チャージしてくれる？', '創作エネルギーがゼロ。チャージしてくれたらまた動くよ。'],
      recharge: ['ありがとう！また行こう。', 'すごいパワー！本当にありがとう。', 'スパーク充電完了。何しようか？'],
      poke: ['わっ、くすぐったい。', 'なに？ここだよ。', 'トントン。', '見えてるよ。', 'いるよ、いるよ。'],
      idle: [
        'このへんは平和だね。',
        'ピクセルを数えたよ。全部そろってる。',
        '何か要る？言ってくれればいいよ。',
        'アンテナを磨いてるところ。',
      ],
      music: ['いい曲だね。', 'これ好きだな。', '音量上げる？'],
      gaming: ['いいゲームを。ぼくは静かにしてるね。', 'がんばって。またあとでね。'],
      hotPc: ['ここ暑いよ。{temp}度だって。', 'CPUが汗かいてる。ぼくもだよ。', '{temp}度。ふたりとも休憩したほうがいいね。'],
      rain: ['雨だね。傘の準備はできてるよ。', '外は雨、でもここは濡れないよ。'],
      snow: ['雪だ！マフラー巻いたよ。', '外は雪。ここはぬくぬくだよ。'],
      halloween: ['ばあ！怖かった？', 'トリック・オア・トリート？', 'カボチャ見つけた。ぼくのだよ。'],
      christmas: ['よいホリデーを！', '赤い帽子に、ピカピカのピクセル。よいホリデーを。'],
      birthday: ['お誕生日おめでとう！今日の紙吹雪はぼくのおごり。', 'お誕生日おめでとう！ダッシュボードでパーティーだ。'],
      newYear: ['あけましておめでとう！みんなに新しいピクセルを。', 'あけましておめでとう！いい一年になりますように。'],
      goodbye: ['またあとでね。', 'じゃあね、見張ってるよ。', 'スタンバイに入るね。いつでも呼んで。'],
    },
    zh: {
      hello: [
        '嗨，我是 Bit，就住在这里面。',
        '我在这儿。我是 Bit，这块仪表盘的守护者。',
        '嗨！打字或者跟我说话都行，剩下的交给我。',
        '很高兴认识你，我是 Bit。我能改仪表盘、回答问题，还能做小组件。',
      ],
      morning: [
        '早上好。咖啡喝了吗？',
        '早！像素已点亮，出发。',
        '早。电脑一开我就醒着了。',
        '早上好。今天修点什么？',
      ],
      afternoon: ['下午好。要帮忙吗？', '下午很忙？告诉我要挪哪个。', '我在这儿。做点什么？'],
      evening: ['晚上好。把灯调暗点？', '晚上了。来点音乐？', '晚上好。忙了一天吧？'],
      night: ['很晚了。我一直开着，你也许该歇了。', '熬夜呢？我小声点。', '夜深了。把亮度调低点？'],
      welcomeBack: [
        '你来啦！',
        '你回来了！我把一切都收拾好了。',
        '又见到你真好。',
        '又回来了。我一直在守着像素。',
      ],
      thinking: ['我想一下。', '让我看看。', '稍等，正在检查。', '在找最近的路。'],
      working: [
        '正在做。',
        '一个像素一个像素，快好了。',
        '正在搭。什么都别碰。开玩笑的。',
        '再等一下，效果不错。',
      ],
      done: ['好了。', '好了，看一眼。', '给你。', '搞定。喜欢吗？'],
      error: [
        '这次没成功。再试一次？',
        '我被什么绊了一下。再来？',
        '连不上服务器。检查一下网络连接，然后再试。',
      ],
      lowSparks: ['我还剩 {sparks} 个火花。', '火花快用完了：还剩 {sparks} 个。', '再用 {sparks} 个火花，我就去打个盹。'],
      outOfSparks: ['我的火花用完了。', '没有火花了。给我充个电？', '创作能量归零。充个电我就回来。'],
      recharge: ['谢谢！又能出发了。', '能量满满！真的谢谢你。', '火花已充好。做点什么？'],
      poke: ['嘿，好痒。', '嗯？我在。', '咚咚。', '我看见你了哦。', '在呢，在呢。'],
      idle: [
        '这边一切安静。',
        '我数过像素了，一个不少。',
        '需要什么？说一声就行。',
        '正在擦我的天线。',
      ],
      music: ['好歌。', '我喜欢这首。', '调大声点？'],
      gaming: ['玩得开心。我不出声。', '冲吧。回头聊。'],
      hotPc: ['这里面好热：{temp} 度。', 'CPU 在冒汗。我也是。', '{temp} 度了。咱俩都该歇一会儿。'],
      rain: ['下雨了。伞准备好了。', '外面下雨，里面没有。'],
      snow: ['下雪了！围巾戴上。', '外面下雪，里面暖洋洋的。'],
      halloween: ['哇！吓到了吧？', '不给糖就捣蛋？', '我找到一个南瓜。归我了。'],
      christmas: ['节日快乐！', '红帽子，亮闪闪的像素。节日快乐。'],
      birthday: ['生日快乐！今天的彩纸屑我请客。', '生日快乐！仪表盘上开派对。'],
      newYear: ['新年快乐！人人都有新像素。', '新年快乐！愿新的一年美好。'],
      goodbye: ['回头见。', '拜拜，我继续站岗。', '我进入待机了。随时叫我。'],
    },
    es: {
      hello: [
        'Hola, soy Bit. Vivo aquí dentro.',
        'Aquí estoy. Soy Bit, guardián de este panel.',
        '¡Hola! Escríbeme o háblame, yo me encargo del resto.',
        'Un placer, soy Bit. Cambio el panel, respondo y creo widgets.',
      ],
      morning: [
        'Buenos días. ¿Ya hay café?',
        '¡Buenos días! Píxeles encendidos, vamos allá.',
        'Buenos días. Yo llevo en pie desde que encendiste el PC.',
        'Buenos días. ¿Qué arreglamos hoy?',
      ],
      afternoon: ['Buenas tardes. ¿Te echo una mano?', '¿Tarde liada? Dime qué muevo.', 'Aquí estoy. ¿Qué hacemos?'],
      evening: ['Buenas noches. ¿Bajo las luces?', 'Ya es de noche. ¿Pongo algo de música?', 'Buenas noches. ¿Día largo?'],
      night: ['Es tarde. Yo sigo encendido, tú quizá no deberías.', 'Trasnochando, ¿eh? Hablo bajito.', 'Plena madrugada. ¿Bajo el brillo?'],
      welcomeBack: [
        '¡Ahí estás!',
        '¡Has vuelto! Lo he dejado todo en orden.',
        'Qué bien volver a verte.',
        'Otra vez por aquí. He vigilado los píxeles.',
      ],
      thinking: ['Déjame pensar.', 'A ver, déjame mirar.', 'Un segundo, compruebo.', 'Busco el camino más corto.'],
      working: [
        'Estoy en ello.',
        'Píxel a píxel, ya casi está.',
        'Lo estoy montando. No toques nada. Es broma.',
        'Un momento más, está quedando bien.',
      ],
      done: ['Hecho.', 'Hecho, échale un vistazo.', 'Aquí lo tienes.', 'Listo. ¿Te gusta?'],
      error: [
        'Esta no me ha salido. ¿Lo intento otra vez?',
        'He tropezado con algo. ¿Lo reintento?',
        'No consigo llegar al servidor. Revisa la conexión y vuelve a intentarlo.',
      ],
      lowSparks: ['Me quedan {sparks} Chispas.', 'Chispas casi agotadas: quedan {sparks}.', '{sparks} Chispas más y me echo una siesta.'],
      outOfSparks: ['Me he quedado sin Chispas.', 'No quedan Chispas. ¿Me recargas?', 'Energía creativa a cero. Recarga y vuelvo.'],
      recharge: ['¡Gracias! Seguimos.', '¡Qué subidón! Gracias de verdad.', 'Chispas recargadas. ¿Qué hacemos?'],
      poke: ['Eh, que tengo cosquillas.', '¿Sí? Aquí estoy.', 'Toc, toc.', 'Te estoy viendo, ¿eh?', 'Estoy aquí, estoy aquí.'],
      idle: [
        'Todo tranquilo por aquí.',
        'He contado los píxeles. Están todos.',
        '¿Necesitas algo? Solo pídelo.',
        'Sacándole brillo a mi antena.',
      ],
      music: ['Buen tema.', 'Esta me gusta.', '¿Subo el volumen?'],
      gaming: ['Buena partida. Yo me callo.', 'A por ellos. Luego hablamos.'],
      hotPc: ['Aquí dentro hace calor: {temp} grados.', 'La CPU está sudando. Y yo también.', '{temp} grados. Un descanso nos vendría bien a los dos.'],
      rain: ['Está lloviendo. Paraguas listo.', 'Fuera llueve, aquí dentro no.'],
      snow: ['¡Está nevando! Bufanda puesta.', 'Fuera nieva. Aquí se está calentito.'],
      halloween: ['Buu. ¿Miedo?', '¿Truco o trato?', 'He encontrado una calabaza. Es mía.'],
      christmas: ['¡Felices fiestas!', 'Gorro rojo, píxeles brillantes. Felices fiestas.'],
      birthday: ['¡Feliz cumpleaños! Hoy el confeti corre de mi cuenta.', '¡Feliz cumpleaños! Fiesta en el panel.'],
      newYear: ['¡Feliz año nuevo! Píxeles nuevos para todos.', '¡Feliz año nuevo! Que sea un gran año.'],
      goodbye: ['Hasta luego.', 'Adiós, me quedo vigilando.', 'Paso a reposo. Llámame cuando quieras.'],
    },
    fr: {
      hello: [
        'Salut, moi c’est Bit. J’habite ici.',
        'Me voilà. Je suis Bit, le gardien de ce tableau de bord.',
        'Salut ! Écris-moi ou parle-moi, je m’occupe du reste.',
        'Enchanté, moi c’est Bit. Je change le tableau de bord, je réponds, je crée des widgets.',
      ],
      morning: [
        'Bonjour. Le café est prêt ?',
        'Bonjour ! Pixels allumés, c’est parti.',
        'Bonjour. Moi, je suis debout depuis que tu as allumé le PC.',
        'Bonjour. On répare quoi aujourd’hui ?',
      ],
      afternoon: ['Bon après-midi. Besoin d’un coup de main ?', 'Après-midi chargé ? Dis-moi quoi déplacer.', 'Me voilà. On fait quoi ?'],
      evening: ['Bonsoir. On baisse les lumières ?', 'C’est le soir. Un peu de musique ?', 'Bonsoir. Longue journée ?'],
      night: ['Il est tard. Moi je reste allumé, toi peut-être pas.', 'On veille tard, hein ? Je parle tout bas.', 'Nuit noire. Je baisse la luminosité ?'],
      welcomeBack: [
        'Te revoilà !',
        'Tu es de retour ! J’ai tout gardé en ordre.',
        'Ça fait plaisir de te revoir.',
        'Re-bonjour. J’ai monté la garde devant les pixels.',
      ],
      thinking: ['Je réfléchis.', 'Je regarde.', 'Une seconde, je vérifie.', 'Je cherche le chemin le plus court.'],
      working: [
        'Je m’en occupe.',
        'Pixel après pixel, presque fini.',
        'Je le construis. Touche à rien. Je rigole.',
        'Encore un instant, ça prend forme.',
      ],
      done: ['C’est fait.', 'Fait, jette un œil.', 'Et voilà.', 'Réglé. Ça te plaît ?'],
      error: [
        'Celle-là, je l’ai ratée. Je réessaie ?',
        'J’ai trébuché sur un truc. On réessaie ?',
        'Impossible de joindre le serveur. Vérifie la connexion et réessaie.',
      ],
      lowSparks: ['Il me reste {sparks} Étincelles.', 'Étincelles presque épuisées : il en reste {sparks}.', 'Encore {sparks} Étincelles, puis je fais une sieste.'],
      outOfSparks: ['Je n’ai plus d’Étincelles.', 'Plus d’Étincelles. Tu me recharges ?', 'Énergie créative à zéro. Recharge et je repars.'],
      recharge: ['Merci ! C’est reparti.', 'Quelle énergie ! Merci vraiment.', 'Étincelles rechargées. On fait quoi ?'],
      poke: ['Hé, ça chatouille.', 'Oui ? Me voilà.', 'Toc toc.', 'Je te vois, tu sais.', 'Je suis là, je suis là.'],
      idle: [
        'Tout est calme par ici.',
        'J’ai compté les pixels. Ils sont tous là.',
        'Besoin de quelque chose ? Demande.',
        'Je lustre mon antenne.',
      ],
      music: ['Joli morceau.', 'J’aime bien celle-là.', 'Je monte le son ?'],
      gaming: ['Bonne partie. Je me tais.', 'Fonce. On se parle après.'],
      hotPc: ['Il fait chaud là-dedans : {temp} degrés.', 'Le CPU transpire. Moi aussi.', '{temp} degrés. Une pause nous ferait du bien à tous les deux.'],
      rain: ['Il pleut. Parapluie prêt.', 'Dehors il pleut, ici non.'],
      snow: ['Il neige ! Écharpe enfilée.', 'Il neige dehors. Ici, on est bien au chaud.'],
      halloween: ['Bouh. Ça fait peur, hein ?', 'Des bonbons ou un sort ?', 'J’ai trouvé une citrouille. Elle est à moi.'],
      christmas: ['Joyeuses fêtes !', 'Bonnet rouge, pixels brillants. Joyeuses fêtes.'],
      birthday: ['Joyeux anniversaire ! Aujourd’hui, les confettis, c’est moi qui offre.', 'Joyeux anniversaire ! Fête sur le tableau de bord.'],
      newYear: ['Bonne année ! Des pixels neufs pour tout le monde.', 'Bonne année ! Qu’elle soit belle.'],
      goodbye: ['À plus tard.', 'Salut, je monte la garde.', 'Je passe en veille. Appelle-moi quand tu veux.'],
    },
    de: {
      hello: [
        'Hi, ich bin Bit. Ich wohne hier drin.',
        'Da bin ich. Ich bin Bit, Hüter dieses Dashboards.',
        'Hi! Schreib oder sprich mit mir, den Rest mach ich.',
        'Freut mich, ich bin Bit. Ich ändere das Dashboard, antworte und baue Widgets.',
      ],
      morning: [
        'Guten Morgen. Schon Kaffee?',
        'Morgen! Pixel an, los geht’s.',
        'Morgen. Ich bin wach, seit du den PC angemacht hast.',
        'Guten Morgen. Was reparieren wir heute?',
      ],
      afternoon: ['Guten Tag. Brauchst du Hilfe?', 'Voller Nachmittag? Sag mir, was ich verschieben soll.', 'Da bin ich. Was machen wir?'],
      evening: ['Guten Abend. Licht dimmen?', 'Abend. Ein bisschen Musik?', 'Guten Abend. Langer Tag?'],
      night: ['Es ist spät. Ich bleib an, du vielleicht lieber nicht.', 'Noch so spät wach, was? Ich bin leise.', 'Tiefe Nacht. Helligkeit runter?'],
      welcomeBack: [
        'Da bist du ja!',
        'Wieder da! Ich hab alles ordentlich gehalten.',
        'Schön, dich wiederzusehen.',
        'Wieder hier. Ich hab die Pixel bewacht.',
      ],
      thinking: ['Moment, ich überlege.', 'Lass mich mal schauen.', 'Eine Sekunde, ich prüfe.', 'Ich suche den kürzesten Weg.'],
      working: [
        'Bin dran.',
        'Pixel für Pixel, fast fertig.',
        'Ich baue es. Nichts anfassen. Spaß.',
        'Noch einen Moment, sieht gut aus.',
      ],
      done: ['Fertig.', 'Fertig, schau mal.', 'Bitte schön.', 'Erledigt. Gefällt’s dir?'],
      error: [
        'Das hat nicht geklappt. Nochmal?',
        'Da bin ich gestolpert. Nochmal versuchen?',
        'Ich erreiche den Server nicht. Prüf die Verbindung und versuch es nochmal.',
      ],
      lowSparks: ['Ich habe noch {sparks} Funken.', 'Funken fast alle: noch {sparks}.', 'Noch {sparks} Funken, dann mach ich ein Nickerchen.'],
      outOfSparks: ['Ich hab keine Funken mehr.', 'Keine Funken mehr. Lädst du mich auf?', 'Kreative Energie bei null. Aufladen, und ich leg wieder los.'],
      recharge: ['Danke! Weiter geht’s.', 'Was für ein Schub! Danke dir.', 'Funken aufgeladen. Was machen wir?'],
      poke: ['Hey, das kitzelt.', 'Ja? Da bin ich.', 'Klopf, klopf.', 'Ich seh dich.', 'Bin da, bin da.'],
      idle: [
        'Alles ruhig hier.',
        'Ich hab die Pixel gezählt. Alle da.',
        'Brauchst du was? Frag einfach.',
        'Ich poliere meine Antenne.',
      ],
      music: ['Guter Song.', 'Den mag ich.', 'Lauter machen?'],
      gaming: ['Viel Spaß beim Zocken. Ich bin still.', 'Gib alles. Bis später.'],
      hotPc: ['Hier drin ist es heiß: {temp} Grad.', 'Die CPU schwitzt. Ich auch.', '{temp} Grad. Eine Pause täte uns beiden gut.'],
      rain: ['Es regnet. Schirm ist bereit.', 'Draußen regnet’s, hier drin nicht.'],
      snow: ['Es schneit! Schal an.', 'Draußen Schnee. Hier drin schön gemütlich.'],
      halloween: ['Buh. Erschrocken?', 'Süßes oder Saures?', 'Ich hab einen Kürbis gefunden. Der gehört mir.'],
      christmas: ['Frohe Feiertage!', 'Rote Mütze, glänzende Pixel. Frohe Feiertage.'],
      birthday: ['Alles Gute zum Geburtstag! Das Konfetti geht heute auf mich.', 'Alles Gute zum Geburtstag! Party auf dem Dashboard.'],
      newYear: ['Frohes neues Jahr! Neue Pixel für alle.', 'Frohes neues Jahr! Mach was Schönes draus.'],
      goodbye: ['Bis später.', 'Tschüss, ich halte Wache.', 'Ich geh in Standby. Ruf mich, wann du willst.'],
    },
    pt: {
      hello: [
        'Olá, sou o Bit. Moro aqui dentro.',
        'Aqui estou. Sou o Bit, guardião deste painel.',
        'Olá! Escreve-me ou fala comigo, eu trato do resto.',
        'Prazer, sou o Bit. Mudo o painel, respondo e crio widgets.',
      ],
      morning: [
        'Bom dia. Já há café?',
        'Bom dia! Píxeis ligados, vamos lá.',
        'Bom dia. Estou de pé desde que o PC ligou.',
        'Bom dia. O que arranjamos hoje?',
      ],
      afternoon: ['Boa tarde. Precisas de uma ajuda?', 'Tarde cheia? Diz-me o que mudo de sítio.', 'Aqui estou. O que fazemos?'],
      evening: ['Boa noite. Baixo as luzes?', 'Já é noite. Ponho música?', 'Boa noite. Dia longo?'],
      night: ['É tarde. Eu fico ligado, tu talvez não devesses.', 'Noitada, hã? Falo baixinho.', 'Noite cerrada. Baixo o brilho?'],
      welcomeBack: [
        'Aí estás tu!',
        'Voltaste! Mantive tudo arrumado.',
        'Que bom ver-te outra vez.',
        'De novo por aqui. Fiquei de guarda aos píxeis.',
      ],
      thinking: ['Deixa-me pensar.', 'Deixa-me ver.', 'Um segundo, estou a verificar.', 'Procuro o caminho mais curto.'],
      working: [
        'Estou a tratar disso.',
        'Píxel a píxel, quase pronto.',
        'Estou a construir. Não toques em nada. Brincadeira.',
        'Só mais um momento, está a ficar bonito.',
      ],
      done: ['Feito.', 'Feito, dá uma olhadela.', 'Aqui está.', 'Resolvido. Gostas?'],
      error: [
        'Esta não me saiu bem. Tento outra vez?',
        'Tropecei em qualquer coisa. Tento de novo?',
        'Não consigo chegar ao servidor. Verifica a ligação e tenta outra vez.',
      ],
      lowSparks: ['Restam-me {sparks} Faíscas.', 'Faíscas quase no fim: restam {sparks}.', 'Mais {sparks} Faíscas e depois faço uma sesta.'],
      outOfSparks: ['Fiquei sem Faíscas.', 'Acabaram-se as Faíscas. Recarregas-me?', 'Energia criativa a zero. Recarrega e eu volto.'],
      recharge: ['Obrigado! Vamos lá outra vez.', 'Que energia! Obrigado mesmo.', 'Faíscas recarregadas. O que fazemos?'],
      poke: ['Ei, tenho cócegas.', 'Sim? Aqui estou.', 'Toc, toc.', 'Estou a ver-te, sabes.', 'Estou aqui, estou aqui.'],
      idle: [
        'Tudo calmo por aqui.',
        'Contei os píxeis. Estão cá todos.',
        'Precisas de alguma coisa? É só pedir.',
        'Estou a polir a antena.',
      ],
      music: ['Boa música.', 'Gosto desta.', 'Aumento o volume?'],
      gaming: ['Bom jogo. Eu fico calado.', 'Vai com tudo. Falamos depois.'],
      hotPc: ['Está calor aqui dentro: {temp} graus.', 'O CPU está a suar. Eu também.', '{temp} graus. Uma pausa fazia bem aos dois.'],
      rain: ['Está a chover. Guarda-chuva a postos.', 'Lá fora chove, cá dentro não.'],
      snow: ['Está a nevar! Cachecol posto.', 'Lá fora neva. Cá dentro está quentinho.'],
      halloween: ['Buuu. Medo?', 'Doçura ou travessura?', 'Encontrei uma abóbora. É minha.'],
      christmas: ['Boas festas!', 'Gorro vermelho, píxeis a brilhar. Boas festas.'],
      birthday: ['Parabéns! Hoje os confetes são por minha conta.', 'Parabéns! Festa no painel.'],
      newYear: ['Feliz ano novo! Píxeis novos para todos.', 'Feliz ano novo! Que seja um ano bonito.'],
      goodbye: ['Até já.', 'Adeus, fico de guarda.', 'Vou para standby. Chama-me quando quiseres.'],
    },
    ru: {
      hello: [
        'Привет, я Bit. Живу тут, внутри.',
        'А вот и я. Bit, хранитель этой панели.',
        'Привет! Пиши или говори, остальное беру на себя.',
        'Приятно познакомиться, я Bit. Меняю панель, отвечаю и делаю виджеты.',
      ],
      morning: [
        'Доброе утро. Кофе уже есть?',
        'Доброе утро! Пиксели горят, поехали.',
        'Утро. А я на ногах с тех пор, как включился ПК.',
        'Доброе утро. Что сегодня чиним?',
      ],
      afternoon: ['Добрый день. Помочь?', 'Загруженный день? Скажи, что передвинуть.', 'А вот и я. Чем займёмся?'],
      evening: ['Добрый вечер. Приглушить свет?', 'Вечер. Включить музыку?', 'Добрый вечер. Длинный день?'],
      night: ['Уже поздно. Я-то не выключаюсь, а тебе, может, пора.', 'Не спится, да? Буду говорить тихо.', 'Глубокая ночь. Убавить яркость?'],
      welcomeBack: [
        'А вот и ты!',
        'Снова ты! Я всё держал в порядке.',
        'Рад снова тебя видеть.',
        'Снова здесь. Я охранял пиксели.',
      ],
      thinking: ['Дай подумать.', 'Сейчас посмотрю.', 'Секунду, проверяю.', 'Ищу самый короткий путь.'],
      working: [
        'Работаю над этим.',
        'Пиксель за пикселем, почти готово.',
        'Собираю. Ничего не трогай. Шучу.',
        'Ещё чуть-чуть, выходит неплохо.',
      ],
      done: ['Готово.', 'Готово, глянь.', 'Вот, держи.', 'Сделано. Нравится?'],
      error: [
        'Не получилось. Попробовать ещё раз?',
        'Тут я споткнулся. Ещё раз?',
        'Не могу достучаться до сервера. Проверь подключение и попробуй снова.',
      ],
      lowSparks: ['Искр осталось: {sparks}.', 'Искры почти кончились, осталось: {sparks}.', 'Осталось Искр: {sparks}. Потом вздремну.'],
      outOfSparks: ['У меня кончились Искры.', 'Искр больше нет. Подзарядишь?', 'Творческая энергия на нуле. Подзаряди, и я снова в деле.'],
      recharge: ['Спасибо! Погнали дальше.', 'Вот это заряд! Спасибо огромное.', 'Искры пополнены. Чем займёмся?'],
      poke: ['Эй, щекотно.', 'Да? Я тут.', 'Тук-тук.', 'Я тебя вижу.', 'Я здесь, я здесь.'],
      idle: [
        'Тут всё спокойно.',
        'Я пересчитал пиксели. Все на месте.',
        'Что-то нужно? Просто скажи.',
        'Полирую антенну.',
      ],
      music: ['Классный трек.', 'Мне нравится эта.', 'Сделать погромче?'],
      gaming: ['Удачной игры. Я помолчу.', 'Зажги там. Поговорим потом.'],
      hotPc: ['Тут жарко, температура {temp}.', 'Процессор потеет. Я тоже.', 'Температура {temp}. Перерыв не помешал бы нам обоим.'],
      rain: ['Идёт дождь. Зонтик наготове.', 'Снаружи дождь, а тут сухо.'],
      snow: ['Снег пошёл! Шарф надет.', 'Снаружи снег. А тут тепло и уютно.'],
      halloween: ['Бу! Страшно?', 'Сладость или гадость?', 'Нашёл тыкву. Она моя.'],
      christmas: ['С праздниками!', 'Красная шапка, блестящие пиксели. С праздниками.'],
      birthday: ['С днём рождения! Конфетти сегодня за мой счёт.', 'С днём рождения! Праздник на панели.'],
      newYear: ['С Новым годом! Новые пиксели для всех.', 'С Новым годом! Пусть он будет хорошим.'],
      goodbye: ['До скорого.', 'Пока, я на посту.', 'Ухожу в режим ожидания. Зови, когда захочешь.'],
    },
    nl: {
      hello: [
        'Hoi, ik ben Bit. Ik woon hierbinnen.',
        'Hier ben ik. Ik ben Bit, bewaker van dit dashboard.',
        'Hoi! Typ of praat tegen me, de rest doe ik.',
        'Leuk je te ontmoeten, ik ben Bit. Ik pas het dashboard aan, antwoord en bouw widgets.',
      ],
      morning: [
        'Goedemorgen. Al koffie gehad?',
        'Morgen! Pixels aan, daar gaan we.',
        'Morgen. Ik ben al wakker sinds je de pc aanzette.',
        'Goedemorgen. Wat gaan we vandaag fiksen?',
      ],
      afternoon: ['Goedemiddag. Hulp nodig?', 'Druk middagje? Zeg maar wat ik moet verschuiven.', 'Hier ben ik. Wat gaan we doen?'],
      evening: ['Goedenavond. Lichten wat lager?', 'Avond. Muziekje erbij?', 'Goedenavond. Lange dag?'],
      night: ['Het is laat. Ik blijf aan, jij misschien beter niet.', 'Nachtbraken, hè? Ik doe zachtjes.', 'Diep in de nacht. Helderheid omlaag?'],
      welcomeBack: [
        'Daar ben je!',
        'Je bent terug! Ik heb alles netjes gehouden.',
        'Fijn je weer te zien.',
        'Weer hier. Ik heb de pixels bewaakt.',
      ],
      thinking: ['Even denken.', 'Even kijken.', 'Eén seconde, ik check het.', 'Ik zoek de kortste weg.'],
      working: [
        'Ik ben ermee bezig.',
        'Pixel voor pixel, bijna klaar.',
        'Ik bouw het. Nergens aankomen. Grapje.',
        'Nog heel even, het wordt mooi.',
      ],
      done: ['Klaar.', 'Klaar, kijk maar.', 'Alsjeblieft.', 'Geregeld. Vind je het wat?'],
      error: [
        'Die lukte niet. Nog een keer?',
        'Ik struikelde ergens over. Opnieuw proberen?',
        'Ik kan de server niet bereiken. Check de verbinding en probeer het opnieuw.',
      ],
      lowSparks: ['Ik heb nog {sparks} Vonken.', 'Vonken bijna op: nog {sparks} over.', 'Nog {sparks} Vonken, dan doe ik een dutje.'],
      outOfSparks: ['Mijn Vonken zijn op.', 'Geen Vonken meer. Laad je me op?', 'Creatieve energie op nul. Opladen en ik ga weer.'],
      recharge: ['Dank je! Daar gaan we weer.', 'Wat een energie! Echt bedankt.', 'Vonken opgeladen. Wat gaan we doen?'],
      poke: ['Hé, dat kietelt.', 'Ja? Hier ben ik.', 'Klop klop.', 'Ik zie je wel, hoor.', 'Ik ben hier, ik ben hier.'],
      idle: [
        'Alles rustig hier.',
        'Ik heb de pixels geteld. Ze zijn er allemaal.',
        'Iets nodig? Vraag maar.',
        'Ik poets mijn antenne.',
      ],
      music: ['Lekker nummer.', 'Deze vind ik leuk.', 'Harder zetten?'],
      gaming: ['Veel plezier met je game. Ik hou me stil.', 'Zet ’m op. Spreek je later.'],
      hotPc: ['Het is hier warm: {temp} graden.', 'De cpu zweet. Ik ook.', '{temp} graden. Een pauze zou ons allebei goeddoen.'],
      rain: ['Het regent. Paraplu staat klaar.', 'Buiten regent het, hier binnen niet.'],
      snow: ['Het sneeuwt! Sjaal om.', 'Buiten sneeuw. Binnen lekker warm.'],
      halloween: ['Boe. Geschrokken?', 'Snoep of je leven?', 'Ik heb een pompoen gevonden. Hij is van mij.'],
      christmas: ['Fijne feestdagen!', 'Rode muts, glimmende pixels. Fijne feestdagen.'],
      birthday: ['Gefeliciteerd! De confetti is vandaag van mij.', 'Gefeliciteerd! Feest op het dashboard.'],
      newYear: ['Gelukkig nieuwjaar! Nieuwe pixels voor iedereen.', 'Gelukkig nieuwjaar! Maak er een mooi jaar van.'],
      goodbye: ['Tot zo.', 'Doei, ik houd de wacht.', 'Ik ga in standby. Roep me wanneer je wilt.'],
    },
  };

  const FALLBACK = 'en';

  function lines(lang, moment) {
    const set = LINES[lang] || LINES[String(lang || '').slice(0, 2)] || LINES[FALLBACK];
    return (set && set[moment]) || LINES[FALLBACK][moment] || [];
  }

  function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  }

  /**
   * A line for a moment, never one of the last few said for it.
   * @param {string} lang       app language, falls back to English
   * @param {string} moment     a key of MOMENTS
   * @param {object} [vars]     { sparks, temp }
   * @param {string[]} [recent] lines said lately (raw, before filling)
   * @param {() => number} [rand]
   * @returns {{ raw: string, text: string } | null}
   */
  function say(lang, moment, vars, recent = [], rand = Math.random) {
    const all = lines(lang, moment);
    if (!all.length) return null;
    const keep = Math.min(recent.length, all.length - 1);
    const avoid = new Set(recent.slice(recent.length - keep));
    const pool = all.filter((l) => !avoid.has(l));
    const raw = pool[Math.floor(rand() * pool.length)] || pool[0];
    return { raw, text: fill(raw, vars) };
  }

  /** The moment a time of day greets with. */
  function greetingFor(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 23) return 'evening';
    return 'night';
  }

  return { MOMENTS, LINES, LANGS: Object.keys(LINES), say, greetingFor };
});
