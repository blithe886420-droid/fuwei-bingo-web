export default async function handler(req, res) {
  try {

    const now = new Date();

    const dateStr = now.toLocaleDateString("sv-SE", {
      timeZone: "Asia/Taipei"
    }).replaceAll("-", "");

    const sourceUrl =
      `https://lotto.auzo.tw/bingobingo/list_${dateStr}.html`;

    const response = await fetch(sourceUrl, {
      headers:{
        "User-Agent":
        "Mozilla/5.0"
      }
    });

    const html = await response.text();

    // 找紅球
    const ballMatches =
      html.match(/>\d{2}</g) || [];

    const numbers =
      ballMatches
        .slice(0,20)
        .map(x => x.replace(/[^\d]/g,""));

    return res.json({
      ok:true,
      source:sourceUrl,
      numbers
    });

  } catch(err){

    return res.json({
      ok:false,
      error:err.message
    });

  }
}
