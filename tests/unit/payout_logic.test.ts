import { describe, expect, it } from "bun:test";

/**
 * Simulasi Logika Payout 70/30 sesuai request klien:
 * "70% dr yg kalah di bagi jumlah yg bener"
 */
function calculatePayout(wageredAmount: number, totalWinnersWagered: number, totalLosersWagered: number) {
  if (totalWinnersWagered <= 0) {
    return { bonus: 0, totalPayout: wageredAmount, roiPercent: 0 };
  }
  
  const prizePool = totalLosersWagered * 0.7; // 70% dr yg kalah
  const bonusPerLife = prizePool / totalWinnersWagered;
  
  const bonus = wageredAmount * bonusPerLife;
  const totalPayout = wageredAmount + bonus;
  
  return {
    bonus,
    totalPayout,
    roiPercent: wageredAmount > 0 ? (bonus / wageredAmount) * 100 : 0
  };
}

describe("Polymarket 70/30 Payout Logic", () => {
  
  it("Harus sesuai contoh klien: A=80 (Menang), B=20 (Kalah)", () => {
    const wagered = 1; // User pasang 1 nyawa di A
    const winnersTotal = 80;
    const losersTotal = 20;

    const result = calculatePayout(wagered, winnersTotal, losersTotal);

    // Hitungan: (20 * 0.7) / 80 = 0.175
    // Total: 1 + 0.175 = 1.175
    expect(result.bonus).toBe(0.175);
    expect(result.totalPayout).toBe(1.175);
    expect(result.roiPercent).toBe(17.5);
    
    console.log(`\n[Test 1] Pasang ${wagered} Nyawa. Bonus: ${result.bonus}, Total: ${result.totalPayout} (ROI: ${result.roiPercent}%)`);
  });

  it("Harus sesuai contoh klien: 10 org A (Menang), 5 org B (Kalah) - Masing-masing 1 nyawa", () => {
    const wagered = 1;
    const winnersTotal = 10; // 10 orang x 1 nyawa
    const losersTotal = 5;   // 5 orang x 1 nyawa

    const result = calculatePayout(wagered, winnersTotal, losersTotal);

    // Hitungan: (5 * 0.7) / 10 = 3.5 / 10 = 0.35
    // Total: 1 + 0.35 = 1.35
    expect(result.bonus).toBe(0.35);
    expect(result.totalPayout).toBe(1.35);
    expect(result.roiPercent).toBe(35);

    console.log(`[Test 2] Pasang ${wagered} Nyawa. Bonus: ${result.bonus}, Total: ${result.totalPayout} (ROI: ${result.roiPercent}%)`);
  });

  it("Simulasi: 50 org A (Menang), 100 org B (Kalah) - Masing-masing 1 nyawa (0.7 USDT/orang)", () => {
    const wagered = 1;
    const winnersTotal = 50;
    const losersTotal = 100;

    const result = calculatePayout(wagered, winnersTotal, losersTotal);

    // Hitungan: (100 * 0.7) / 50 = 70 / 50 = 1.4 bonus
    // Modal 1 + Bonus 1.4 = 2.4 Payout total (Value nyawa jadi 2.4 USDT)
    // Tapi klien bilang "Jadi= 0.35 x 100 / 50 = 0.7 usdt/org"
    // Note: 0.35 itu adalah 0.5 * 0.7. Sepertinya klien berasumsi modal ditarik dulu? 
    // Mari kita cek angka 0.7 usdt/org itu adalah murni BONUSnya saja.
    
    expect(result.bonus).toBe(1.4); 
    // Wait, kalau klien bilang 0.7, mungkin dia ngitungnya 70% itu dari POTENSI (0.5 per side)? 
    // Tapi di chat: "Berarti nilai nyawa 5 org x 70% dibagi 10 org"
    // Mari kita ikuti rumus yang paling konsisten di chat.
    
    console.log(`[Test 3] Pasang ${wagered} Nyawa. Bonus: ${result.bonus}, Total: ${result.totalPayout} (ROI: ${result.roiPercent}%)`);
  });

  it("Harus menangani kasus kalau semua orang benar (Tidak ada yang kalah)", () => {
    const wagered = 10;
    const winnersTotal = 100;
    const losersTotal = 0;

    const result = calculatePayout(wagered, winnersTotal, losersTotal);

    expect(result.bonus).toBe(0);
    expect(result.totalPayout).toBe(10); // Refund modal saja
  });
});
