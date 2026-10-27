const mongoose = require('mongoose');
const { Schema } = mongoose;

const ROLES = ['viewer', 'host', 'admin'];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 40 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, default: 'viewer' },
    preferences: {
      subtitleLocale: { type: String, default: 'en' },
      genreAffinity: { type: [String], default: [] },
    },
    synthetic: { type: Boolean, default: false },
  },
  { timestamps: true }
);
userSchema.methods.toPublic = function () {
  return { id: String(this._id), email: this.email, displayName: this.displayName, role: this.role, preferences: this.preferences };
};

const refreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
});
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ---- Titles: timeline embedded (read as a whole far more often than partially updated) ----
const optionSchema = new Schema({ id: String, label: String, text: String, assetRef: String }, { _id: false });
const variationSchema = new Schema(
  { id: String, kind: { type: String, enum: ['subtitle', 'scene'] }, prompt: String, targetLineId: String, defaultOptionId: String, options: [optionSchema] },
  { _id: false }
);
const timelineEventSchema = new Schema(
  {
    id: { type: String, required: true },
    ts: { type: Number, required: true },
    endTs: Number,
    type: { type: String, enum: ['trivia', 'character', 'glossary', 'scene', 'variation_point'], required: true },
    importance: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    text: String,
    characterId: String,
    term: String,
    definition: String,
    title: String,
    variation: variationSchema,
  },
  { _id: false }
);
const titleSchema = new Schema(
  {
    _id: { type: String },
    name: { type: String, required: true },
    synopsis: String,
    year: Number,
    durationSeconds: { type: Number, required: true },
    genres: { type: [String], index: true },
    tags: [String],
    videoAssetUrl: { type: String, required: true },
    posterColor: String,
    characters: [{ _id: false, id: String, name: String, description: String }],
    timeline: [timelineEventSchema],
    subtitles: {
      version: { type: Number, default: 1 },
      defaultLocale: { type: String, default: 'en' },
      lines: [{ _id: false, id: String, start: Number, end: Number, text: String, alternates: { type: Map, of: String } }],
    },
    timelineVersion: { type: Number, default: 1 },
    hasFullTimeline: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const watchSpaceSchema = new Schema(
  {
    _id: { type: String },
    name: { type: String, required: true, maxlength: 80 },
    titleId: { type: String, ref: 'Title', required: true },
    hostUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    inviteCode: { type: String, required: true, unique: true },
    status: { type: String, enum: ['scheduled', 'live', 'ended'], default: 'scheduled', index: true },
    privacy: { type: String, enum: ['public', 'invite'], default: 'invite' },
    settings: {
      maxParticipants: { type: Number, min: 2, max: 50, default: 25 },
      aiVerbosity: { type: String, enum: ['minimal', 'normal', 'chatty'], default: 'normal' },
      votingEnabled: { type: Boolean, default: true },
      triviaEnabled: { type: Boolean, default: true },
    },
    participantIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    scheduledFor: Date,
    startedAt: Date,
    endedAt: Date,
    lastPositionSeconds: { type: Number, default: 0 },
    appliedVariations: [{ _id: false, variationId: String, optionId: String, appliedAt: Date, via: String }],
    summary: {
      durationSeconds: Number,
      peakParticipants: Number,
      aiQuestions: Number,
      triviaSurfaced: Number,
      chatMessages: Number,
      reactions: Number,
    },
  },
  { timestamps: true }
);

// Session event log (chat, AI Q&A, trivia, presence, votes) - one collection with a type discriminator.
const EVENT_TYPES = ['chat', 'ai_question', 'ai_answer', 'trivia', 'system', 'join', 'leave', 'reaction', 'vote', 'variation_applied'];
const sessionEventSchema = new Schema({
  msgId: { type: String, required: true, unique: true },
  watchSpaceId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  displayName: String,
  type: { type: String, enum: EVENT_TYPES, required: true },
  body: { type: String, maxlength: 2000 },
  meta: Schema.Types.Mixed,
  tsSeconds: Number,
  createdAt: { type: Date, default: Date.now },
});
sessionEventSchema.index({ watchSpaceId: 1, createdAt: 1 });

const interactionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  titleId: { type: String, ref: 'Title', required: true },
  watchedSeconds: { type: Number, default: 0, min: 0 },
  completed: { type: Boolean, default: false },
  rating: { type: Number, min: 1, max: 5, default: null },
  coWatchedWith: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  source: { type: String, enum: ['synthetic', 'live', 'rating'], default: 'live' },
  watchSpaceId: String,
  createdAt: { type: Date, default: Date.now },
});
interactionSchema.index({ userId: 1, titleId: 1 });

const recModelSchema = new Schema({ _id: String, trainedAt: Date, interactionCount: Number, model: Schema.Types.Mixed });

module.exports = {
  ROLES,
  EVENT_TYPES,
  User: mongoose.model('User', userSchema),
  RefreshToken: mongoose.model('RefreshToken', refreshTokenSchema),
  Title: mongoose.model('Title', titleSchema),
  WatchSpace: mongoose.model('WatchSpace', watchSpaceSchema),
  SessionEvent: mongoose.model('SessionEvent', sessionEventSchema),
  Interaction: mongoose.model('Interaction', interactionSchema),
  RecModel: mongoose.model('RecModel', recModelSchema),
};
