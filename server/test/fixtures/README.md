# Test fixtures

Real captured data, checked in so the suite stays offline and deterministic.

The `linux-*` files are raw output from a Linux box (Ubuntu 24.04, X11, PipeWire)
and are consumed by `linux-collectors.test.mjs`. They are stored with their
original line endings and pinned as binary in `.gitattributes`, because `\r` is a
line terminator in a JavaScript regex: if git rewrote them to CRLF on a Windows
checkout, a `$`-anchored parser would match nothing and the tests would fail for
a reason that has nothing to do with the parser under test.

## adhan-reference.json

Prayer times from [api.aladhan.com](https://api.aladhan.com), the widely used
implementation of the same authorities' published rules, used by
`adhan.test.mjs` to cross-check the local computation in `server/adhan.js`.

108 rows: nine calculation methods across six cities (Cairo, Makkah, Istanbul,
Dubai, Jakarta, London), both Asr schools, for a fixed date. The high-latitude
rule is pinned to angle-based (`latitudeAdjustmentMethod=3`) and recorded on
every row, because London in July needs one and the three rules disagree by well
over an hour there.

Regenerate only when the method table in `server/adhan.js` changes:

```bash
node -e '
const M=[["egyptian",5],["mwl",3],["isna",2],["makkah",4],["karachi",1],
         ["dubai",16],["turkey",13],["singapore",11],["tehran",7]];
const C=[["Cairo",30.0444,31.2357,"Africa/Cairo"],["Makkah",21.3891,39.8579,"Asia/Riyadh"],
         ["Istanbul",41.0082,28.9784,"Europe/Istanbul"],["Dubai",25.2048,55.2708,"Asia/Dubai"],
         ["Jakarta",-6.2088,106.8456,"Asia/Jakarta"],["London",51.5074,-0.1278,"Europe/London"]];
const DATE="19-07-2026", LAM=3, rows=[];
(async()=>{
for (const [mk,mid] of M) for (const [city,lat,lon,tz] of C) for (const school of [0,1]) {
  const u=`https://api.aladhan.com/v1/timings/${DATE}?latitude=${lat}&longitude=${lon}`
         +`&method=${mid}&school=${school}&latitudeAdjustmentMethod=${LAM}`;
  const t=(await (await fetch(u)).json()).data.timings;
  const k=["Fajr","Sunrise","Dhuhr","Asr","Maghrib","Isha"];
  rows.push({method:mk,city,lat,lon,tz,asr:school?"hanafi":"standard",date:DATE,
             highLat:"angleBased",
             expect:Object.fromEntries(k.map(x=>[x.toLowerCase(),t[x]]))});
  await new Promise(r=>setTimeout(r,120));
}
require("fs").writeFileSync("server/test/fixtures/adhan-reference.json",
  JSON.stringify({source:"api.aladhan.com/v1/timings",date:DATE,
    latitudeAdjustmentMethod:"angleBased (aladhan latitudeAdjustmentMethod=3)",
    note:"Reference times for cross-checking the local computation.",rows},null,1));
console.log("rows:",rows.length);
})();'
```

The test allows two minutes of disagreement. The reference publishes
minute-resolution times, so half a minute of that is quantization, and the two
implementations use slightly different solar-position series. Measured worst
case across all 648 comparisons is 1.5 minutes.
