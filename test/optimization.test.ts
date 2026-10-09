import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import { listCreators } from "../src/list-creators.ts";
import { CAMPAIGN_ID, seed } from "../src/seed.ts";
import { listCreators as originalListCreators } from "./reference/original-list-creators.ts";

const databases: DatabaseSync[] = [];

function database() {
  const db = openDatabase();
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("equivalência e orçamento da otimização", () => {
  it.each([17, 99])("mantém todas as posições e páginas com 4000 criadores (seed %s)", async (randomSeed) => {
    const db = database();
    seed(db, { creators: 4000, seed: randomSeed });
    const input = { campaignId: CAMPAIGN_ID, limit: 4000, offset: 0 };
    const original = await originalListCreators(db, input);
    expect(original).not.toBeNull();

    resetQueryCount();
    const optimized = await listCreators(db, input);
    expect(optimized).toEqual(original);
    expect(getQueryCount()).toBe(4);

    const app = createApp(db);
    for (const [limit, offset] of [
      [1, 0], [20, 0], [50, 49], [20, original!.total - 1],
      [20, original!.total], [50, original!.total + 100],
    ]) {
      resetQueryCount();
      const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=${limit}&offset=${offset}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        campaign_id: CAMPAIGN_ID,
        total: original!.total,
        creators: original!.creators.slice(offset, offset + limit),
      });
      expect(getQueryCount()).toBe(4);
    }
  });

  it("preserva empates, vários nichos repetidos, múltiplas contas e o limite inclusivo de 90 dias", async () => {
    const db = database();
    db.exec(`
      INSERT INTO campaigns VALUES ('edge', 'Borda', '["tech","tech","beleza"]');
      INSERT INTO creators VALUES
        ('repeated', 'Repetido', '["tech","tech"]', ''),
        ('accounts', 'Contas', '["tech"]', ''),
        ('😀', 'Id suplementar', '["tech"]', ''),
        ('', 'Id BMP', '["tech"]', ''),
        ('missing', 'Sem conta', '["beleza"]', ''),
        ('unmeasured', 'Sem métrica', '["beleza"]', ''),
        ('unmatched', 'Fora', '["comida"]', '');
      INSERT INTO social_accounts VALUES
        ('a1', 'accounts', 'instagram'), ('a2', 'accounts', 'tiktok'),
        ('a3', 'accounts', 'youtube'), ('empty', 'unmeasured', 'instagram');
      INSERT INTO metrics VALUES
        ('new_z', 'a1', 30, '2026-06-01T00:00:00.000Z', ''),
        ('new_a', 'a1', 900, '2026-06-01T00:00:00.000Z', ''),
        ('old_z', 'a1', 9999, '2026-05-31T00:00:00.000Z', ''),
        ('only', 'a2', 20, '2026-06-01T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES
        ('inside', 'accounts', '2026-03-03T12:00:00.000Z'),
        ('outside', 'accounts', '2026-03-03T11:59:59.999Z'),
        ('recent', 'accounts', '2026-05-31T00:00:00.000Z');
    `);
    const input = { campaignId: "edge", limit: 50, offset: 0 };
    const original = await originalListCreators(db, input);
    const optimized = await listCreators(db, input);
    expect(optimized).toEqual(original);
    expect(optimized!.creators.map((creator) => creator.id)).toEqual([
      "repeated", "accounts", "😀", "", "missing", "unmeasured",
    ]);
    expect(optimized!.creators[0].niche_score).toBe(4);
    expect(optimized!.creators[1]).toMatchObject({ latest_reach: 50, deliveries_90d: 2 });
  });

  it("reflete mutações no banco na próxima página, sem cache da campanha", async () => {
    const db = database();
    db.exec(`
      INSERT INTO campaigns VALUES ('mutable', 'Mutável', '["tech"]');
      INSERT INTO creators VALUES ('a', 'A', '["tech"]', ''), ('b', 'B', '["tech"]', '');
      INSERT INTO social_accounts VALUES ('account', 'b', 'instagram');
      INSERT INTO metrics VALUES ('before', 'account', 0, '2026-05-01T00:00:00.000Z', '');
    `);
    const input = { campaignId: "mutable", limit: 20, offset: 0 };
    expect((await listCreators(db, input))!.creators[0].id).toBe("a");
    db.exec(`
      INSERT INTO metrics VALUES ('after', 'account', 500, '2026-06-01T00:00:00.000Z', '');
      INSERT INTO deliveries VALUES ('delivery', 'b', '2026-06-01T00:00:00.000Z');
      UPDATE creators SET name = 'B atualizado' WHERE id = 'b';
    `);
    const result = await listCreators(db, input);
    expect(result).toEqual(await originalListCreators(db, input));
    expect(result!.creators[0]).toEqual({
      id: "b", name: "B atualizado", niche_score: 1, latest_reach: 500, deliveries_90d: 1,
    });
  });

  it("mantém normalização HTTP de limites, offsets inválidos e campanha ausente", async () => {
    const db = database();
    seed(db, { creators: 120, seed: 31 });
    const all = await originalListCreators(db, { campaignId: CAMPAIGN_ID, limit: 120, offset: 0 });
    const app = createApp(db);
    for (const [query, limit, offset] of [
      ["", 20, 0], ["?limit=1000&offset=2.9", 50, 2],
      ["?limit=0&offset=-50", 20, 0], ["?limit=nope&offset=Infinity", 20, 0],
    ] as const) {
      const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators${query}`);
      expect(await response.json()).toEqual({
        campaign_id: CAMPAIGN_ID, total: all!.total, creators: all!.creators.slice(offset, offset + limit),
      });
    }
    resetQueryCount();
    const missing = await app.request("/campaigns/missing/creators");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "campanha não encontrada" });
    expect(getQueryCount()).toBe(1);
  });

  it("retorna total zero com banco vazio ou campanha sem nichos compatíveis", async () => {
    const db = database();
    db.exec(`INSERT INTO campaigns VALUES ('empty', 'Vazia', '[]');`);
    const input = { campaignId: "empty", limit: 20, offset: 10 };
    expect(await listCreators(db, input)).toEqual({ campaign_id: "empty", total: 0, creators: [] });
    db.exec(`INSERT INTO creators VALUES ('unmatched', 'Fora', '["games"]', '');`);
    resetQueryCount();
    expect(await listCreators(db, input)).toEqual(await originalListCreators(db, input));
    resetQueryCount();
    await listCreators(db, input);
    expect(getQueryCount()).toBe(2);
  });
});
