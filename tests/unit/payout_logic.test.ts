import { describe, expect, it } from "bun:test";

/**
 * Simulasi Logika Payout 70/30:
 * - 70% losing pool menjadi prize for winner, dibagi rata per user pemenang.
 * - Winning bet/modal pemenang dikembalikan.
 * - 30% losing pool menjadi prize for admin/system.
 * - Jika loser adalah downline master, 3% dari losing wager masuk ke master.
 */
function calculatePayout(winningWageredAmount: number, winnerCount: number, totalLosersWagered: number) {
  const prizeForWinner = totalLosersWagered * 0.7;
  const prizeForSystem = totalLosersWagered * 0.3;
  const bonus = winnerCount > 0 ? prizeForWinner / winnerCount : 0;
  const totalPayout = winningWageredAmount + bonus;

  return {
    prizeForWinner,
    prizeForSystem,
    bonus,
    totalPayout,
    roiPercent: winningWageredAmount > 0 ? (bonus / winningWageredAmount) * 100 : 0
  };
}

function calculateMasterCommission(losingWageredAmount: number, livesToUsdtRate = 1) {
  const masterCommissionLives = losingWageredAmount * 0.03;
  const remainingSystemPrizeLives = losingWageredAmount * 0.27;
  return {
    masterCommissionLives,
    remainingSystemPrizeLives,
    masterCommissionUsdt: masterCommissionLives * livesToUsdtRate,
  };
}

describe("Polymarket 70/30 Payout Logic", () => {
  
  it("membagi 70% losing pool rata per user pemenang dan mengembalikan modal", () => {
    const result = calculatePayout(10, 2, 100);

    expect(result.prizeForWinner).toBe(70);
    expect(result.prizeForSystem).toBe(30);
    expect(result.bonus).toBe(35);
    expect(result.totalPayout).toBe(45);
    expect(result.roiPercent).toBe(350);
  });

  it("winner dengan modal lebih besar tetap hanya mendapat bonus rata per user", () => {
    const smallWinner = calculatePayout(10, 2, 100);
    const bigWinner = calculatePayout(50, 2, 100);

    expect(smallWinner.bonus).toBe(35);
    expect(smallWinner.totalPayout).toBe(45);
    expect(bigWinner.bonus).toBe(35);
    expect(bigWinner.totalPayout).toBe(85);
  });

  it("membagi prize for winner dari semua loser", () => {
    const result = calculatePayout(1, 50, 100);

    expect(result.prizeForWinner).toBe(70);
    expect(result.bonus).toBe(1.4);
    expect(result.totalPayout).toBe(2.4);
  });

  it("hanya refund modal kalau tidak ada loser", () => {
    const result = calculatePayout(10, 5, 0);

    expect(result.bonus).toBe(0);
    expect(result.totalPayout).toBe(10);
  });

  it("menghitung komisi master dari losing wager downline milik master", () => {
    const result = calculateMasterCommission(100, 1);

    expect(result.masterCommissionLives).toBe(3);
    expect(result.masterCommissionUsdt).toBe(3);
    expect(result.remainingSystemPrizeLives).toBe(27);
  });

  it("mengonversi komisi master ke USDT dengan platform rate", () => {
    const result = calculateMasterCommission(150, 0.5);

    expect(result.masterCommissionLives).toBe(4.5);
    expect(result.masterCommissionUsdt).toBe(2.25);
    expect(result.remainingSystemPrizeLives).toBe(40.5);
  });
});
