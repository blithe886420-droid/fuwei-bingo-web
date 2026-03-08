export function parseAuzoBingoDraws(html, dateStr) {
  const rows = []
  const rowRegex = /<tr class="bingo_row">([\s\S]*?)<\/tr>/g

  let match

  while ((match = rowRegex.exec(html)) !== null) {
    const rowHtml = match[1]

    const periodMatch = rowHtml.match(
      /<td class="BPeriod"><b>(\d+)<\/b><br>(\d{2}:\d{2})<\/td>/
    )

    if (!periodMatch) continue

    const draw_no = periodMatch[1]
    const drawClock = periodMatch[2]

    const divMatches = [
      ...rowHtml.matchAll(/<div class="[^"]*">(\d{2})<\/div>/g)
    ]

    const numbers = divMatches.map(m => m[1])

    if (numbers.length !== 20) continue

    const yyyy = dateStr.slice(0, 4)
    const mm = dateStr.slice(4, 6)
    const dd = dateStr.slice(6, 8)

    rows.push({
      draw_no,
      draw_time: `${yyyy}-${mm}-${dd} ${drawClock}:00`,
      numbers: numbers.join(" ")
    })
  }

  return rows
}
