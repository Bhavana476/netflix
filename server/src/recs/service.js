// Persists/loads the batch-trained model and serves per-user rails from the latest interactions.
const { Interaction, Title, RecModel, User } = require('../models');
const { train, recommend } = require('./recommender');
const log = require('../logger');

let current = null;

async function retrain() {
  const [interactions, titles] = await Promise.all([
    Interaction.find({}, { userId: 1, titleId: 1, watchedSeconds: 1, completed: 1, rating: 1, coWatchedWith: 1 }).lean(),
    Title.find({}, { name: 1, genres: 1, tags: 1, durationSeconds: 1 }).lean(),
  ]);
  const started = Date.now();
  const model = train(interactions, titles);
  const doc = { _id: 'current', trainedAt: new Date(), interactionCount: interactions.length, model };
  await RecModel.findOneAndUpdate({ _id: 'current' }, doc, { upsert: true });
  current = doc;
  log.info('recommender trained', { interactions: interactions.length, items: model.items, users: model.users, ms: Date.now() - started });
  return { trainedAt: doc.trainedAt, interactionCount: doc.interactionCount, items: model.items, users: model.users, trainMs: Date.now() - started };
}

async function getModel() {
  if (current) return current;
  current = await RecModel.findById('current').lean();
  if (!current) await retrain();
  return current;
}

async function railFor(userId, k = 10) {
  const [model, titles, mine, user] = await Promise.all([
    getModel(),
    Title.find({}, { name: 1, genres: 1, tags: 1, durationSeconds: 1, posterColor: 1, year: 1, synopsis: 1, videoAssetUrl: 1, hasFullTimeline: 1 }).lean(),
    Interaction.find({ userId }).lean(),
    User.findById(userId).lean(),
  ]);
  const recs = recommend({ userInteractions: mine, titles, model: model.model, k, genreAffinity: (user && user.preferences && user.preferences.genreAffinity) || [] });
  const byId = new Map(titles.map((t) => [t._id, t]));
  return {
    modelTrainedAt: model.trainedAt,
    basedOnInteractions: mine.length,
    items: recs.map((r) => {
      const t = byId.get(r.titleId);
      return { ...r, title: { id: t._id, name: t.name, genres: t.genres, year: t.year, posterColor: t.posterColor, synopsis: t.synopsis, hasFullTimeline: t.hasFullTimeline } };
    }),
  };
}

module.exports = { retrain, getModel, railFor };
