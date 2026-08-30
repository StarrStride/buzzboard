import express from "express";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { Server } from "socket.io";

import {
  getSavedGames,
  saveGameToLibrary,
  loadGameFromLibrary,
  deleteGameFromLibrary,
  CLUE_IMAGE_MAX_BYTES,
  saveClueImage,
  loadClueImage,

  CLUE_AUDIO_MAX_BYTES,
  saveClueAudio,
  loadClueAudio,
} from "./storage.js";

dotenv.config();

const app = express();
const port = 3001;

const TEST_CLUE_LIMIT = null;

const BUZZ_WINDOW_MS = 10_000;
const ANSWER_WINDOW_MS = 8_000;
const DAILY_DOUBLE_ANSWER_MS = 12_000;

const httpServer = createServer(app);
const io =
  new Server(
    httpServer,
    {
      /*
       * Clue images are capped at 5 MB,
       * with a little protocol overhead
       * allowed for Socket.IO.
       */
      maxHttpBufferSize:
        6 *
        1024 *
        1024,
    }
  );

app.use(express.json());

/*
 * --------------------------------
 * CLUE AUDIO API
 * --------------------------------
 *
 * Uploads use the authenticated
 * host Socket.IO connection.
 *
 * Audio retrieval is read-only.
 */

app.get(
  "/api/clue-audio/:filename",

  async (
    req,
    res
  ) => {
    try {
      const audio =
        await loadClueAudio(
          req.params.filename
        );


      if (!audio) {
        return res
          .status(
            404
          )
          .json({
            error:
              "Clue audio not found.",
          });
      }


      res.setHeader(
        "Content-Type",
        audio.mimeType
      );

      res.setHeader(
        "Content-Length",
        String(
          audio.size
        )
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable"
      );


      return res.send(
        audio.contents
      );
    }
    catch (error) {
      console.error(
        "Could not serve clue audio:",
        error
      );


      return res
        .status(
          500
        )
        .json({
          error:
            "Could not load clue audio.",
        });
    }
  }
);


/*
 * --------------------------------
 * CLUE IMAGE API
 * --------------------------------
 *
 * Uploads happen through the
 * authenticated host Socket.IO
 * connection.
 *
 * This HTTP route is read-only so
 * every player can display the image.
 */

app.get(
  "/api/clue-images/:filename",

  async (
    req,
    res
  ) => {
    try {
      const image =
        await loadClueImage(
          req.params.filename
        );

      if (!image) {
        return res
          .status(
            404
          )
          .json({
            error:
              "Clue image not found.",
          });
      }


      /*
       * UUID filenames never change,
       * so browsers may safely cache
       * them for a long time.
       */
      res.setHeader(
        "Content-Type",
        image.mimeType
      );

      res.setHeader(
        "Content-Length",
        String(
          image.size
        )
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=31536000, immutable"
      );


      return res.send(
        image.contents
      );
    }
    catch (error) {
      console.error(
        "Could not serve clue image:",
        error
      );

      return res
        .status(
          500
        )
        .json({
          error:
            "Could not load clue image.",
        });
    }
  }
);


/*
 * --------------------------------
 * DISCORD OAUTH
 * --------------------------------
 */

app.post("/api/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body: new URLSearchParams({
          client_id:
            process.env.DISCORD_CLIENT_ID,

          client_secret:
            process.env.DISCORD_CLIENT_SECRET,

          grant_type:
            "authorization_code",

          code:
            req.body.code,
        }),
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "Discord token error:",
        data
      );

      return res
        .status(response.status)
        .json(data);
    }

    res.json({
      access_token:
        data.access_token,
    });
  } catch (error) {
    console.error(
      "Token exchange failed:",
      error
    );

    res.status(500).json({
      error:
        "Token exchange failed",
    });
  }
});


/*
 * --------------------------------
 * ACTIVE GAMES + TIMER HANDLES
 * --------------------------------
 */

const games =
  new Map();

const buzzerTimeouts =
  new Map();

const answerTimeouts =
  new Map();


function clearStoredTimeout(
  timeoutMap,
  instanceId
) {
  const timeout =
    timeoutMap.get(
      instanceId
    );

  if (timeout) {
    clearTimeout(
      timeout
    );

    timeoutMap.delete(
      instanceId
    );
  }
}


function clearBuzzerCountdown(
  game
) {
  clearStoredTimeout(
    buzzerTimeouts,
    game.instanceId
  );

  game.timers.buzzerEndsAt =
    null;
}


function clearAnswerCountdown(
  game
) {
  clearStoredTimeout(
    answerTimeouts,
    game.instanceId
  );

  game.timers.answerEndsAt =
    null;

  game.timers.answerType =
    null;

  game.timers.answerPlayerId =
    null;
}


function clearAllGameTimers(
  game
) {
  clearBuzzerCountdown(
    game
  );

  clearAnswerCountdown(
    game
  );
}


function createGame(
  instanceId,
  hostPlayer
) {
  const game = {
    instanceId,

    hostId:
      hostPlayer.id,

    phase:
      "lobby",

    currentRound:
      1,

    players:
      new Map(),

    gameConfig:
      null,

    currentClue:
      null,

    usedClues:
      new Set(),

    buzzer: {
      open:
        false,

      winner:
        null,

      lockedOut:
        new Set(),
    },

    dailyDouble: {
      playerId:
        null,

      wager:
        null,

      wagerLocked:
        false,
    },

    timers: {
      buzzerEndsAt:
        null,

      answerEndsAt:
        null,

      answerType:
        null,

      answerPlayerId:
        null,
    },

    finalRound: {
      submissions:
        new Map(),

      answersRevealed:
        false,
    },
    undoSnapshot:
      null,
  };

  games.set(
    instanceId,
    game
  );

  return game;
}


/*
 * --------------------------------
 * BASIC GAME HELPERS
 * --------------------------------
 */

function playerIsHost(
  game,
  playerId
) {
  return (
    game.hostId ===
    playerId
  );
}
/*
 * --------------------------------
 * ONE-LEVEL HOST UNDO
 * --------------------------------
 */

function saveUndoSnapshot(
  game,
  label
) {
  game.undoSnapshot =
    structuredClone({
      label,

      hostId:
        game.hostId,

      phase:
        game.phase,

      currentRound:
        game.currentRound,

      players:
        game.players,

      gameConfig:
        game.gameConfig,

      currentClue:
        game.currentClue,

      usedClues:
        game.usedClues,

      buzzer:
        game.buzzer,

      dailyDouble:
        game.dailyDouble,

      timers:
        game.timers,

      finalRound:
        game.finalRound,
    });
}


function restoreUndoSnapshot(
  game
) {
  const snapshot =
    game.undoSnapshot;

  if (!snapshot) {
    return false;
  }

  clearAllGameTimers(
    game
  );

  game.hostId =
    snapshot.hostId;

  game.phase =
    snapshot.phase;

  game.currentRound =
    snapshot.currentRound ??
    1;

  game.players =
    snapshot.players;

  game.gameConfig =
    snapshot.gameConfig;

  game.currentClue =
    snapshot.currentClue;

  game.usedClues =
    snapshot.usedClues;

  game.buzzer =
    snapshot.buzzer;

  game.dailyDouble =
    snapshot.dailyDouble;

  game.finalRound =
    snapshot.finalRound;

  const previousTimers =
    snapshot.timers;

  game.timers = {
    buzzerEndsAt:
      null,

    answerEndsAt:
      null,

    answerType:
      null,

    answerPlayerId:
      null,
  };

  game.undoSnapshot =
    null;

  /*
   * If the restored state had an
   * active countdown, restart it at
   * its full duration rather than
   * trying to resume an old deadline.
   */
  if (
    previousTimers
      ?.buzzerEndsAt !==
      null &&
    game.phase ===
      "clue" &&
    game.buzzer.open &&
    !game.buzzer.winner
  ) {
    startBuzzerWindow(
      game
    );
  } else if (
    previousTimers
      ?.answerEndsAt !==
      null &&
    previousTimers
      ?.answerPlayerId
  ) {
    const player =
      game.players.get(
        previousTimers
          .answerPlayerId
      );

    if (player) {
      if (
        previousTimers
          .answerType ===
          "daily_double" &&
        game.phase ===
          "daily_double_clue"
      ) {
        startDailyDoubleAnswerWindow(
          game,
          player
        );
      } else if (
        previousTimers
          .answerType ===
          "normal" &&
        game.phase ===
          "clue" &&
        game.buzzer
          .winner
          ?.playerId ===
          player.id
      ) {
        startNormalAnswerWindow(
          game,
          player
        );
      }
    }
  }

  return true;
}


function resetBuzzer(
  game
) {
  clearBuzzerCountdown(
    game
  );

  clearAnswerCountdown(
    game
  );

  game.buzzer.open =
    false;

  game.buzzer.winner =
    null;

  game.buzzer.lockedOut.clear();
}


function resetScores(
  game
) {
  for (
    const player of
    game.players.values()
  ) {
    player.score = 0;
  }
}


function resetFinalRound(
  game
) {
  game.finalRound
    .submissions
    .clear();

  game.finalRound
    .answersRevealed =
    false;
}


function resetDailyDouble(
  game
) {
  game.dailyDouble.playerId =
    null;

  game.dailyDouble.wager =
    null;

  game.dailyDouble.wagerLocked =
    false;
}


function resetBoardState(
  game
) {
  clearAllGameTimers(
    game
  );

  game.undoSnapshot =
    null;

  game.usedClues.clear();

  game.currentClue =
    null;

  resetBuzzer(
    game
  );

  resetDailyDouble(
    game
  );
}


function resetRound(
  game
) {
  resetBoardState(
    game
  );

  game.currentRound =
    1;

  resetScores(
    game
  );

  resetFinalRound(
    game
  );
}


function getRoundCategories(
  game
) {
  if (
    !game.gameConfig
  ) {
    return [];
  }

  if (
    game.currentRound ===
      2
  ) {
    return Array.isArray(
      game.gameConfig
        .round2Categories
    )
      ? game.gameConfig
          .round2Categories
      : [];
  }

  return Array.isArray(
    game.gameConfig
      .categories
  )
    ? game.gameConfig
        .categories
    : [];
}


function getTotalClueCount(
  game
) {
  return getRoundCategories(
    game
  ).reduce(
    (
      total,
      category
    ) =>
      total +
      (
        Array.isArray(
          category.clues
        )
          ? category
              .clues
              .length
          : 0
      ),

    0
  );
}


function getHighestClueValue(
  game
) {
  let highest =
    0;

  for (
    const category of
    getRoundCategories(
      game
    )
  ) {
    for (
      const clue of
      category.clues ??
      []
    ) {
      if (
        Number.isFinite(
          clue.value
        )
      ) {
        highest =
          Math.max(
            highest,
            clue.value
          );
      }
    }
  }

  return highest;
}


function getDailyDoubleMaxWager(
  game,
  player
) {
  return Math.max(
    0,

    Math.floor(
      player?.score ??
      0
    ),

    getHighestClueValue(
      game
    )
  );
}


function cleanText(
  value,
  fallback = ""
) {
  if (
    typeof value !==
    "string"
  ) {
    return fallback;
  }

  return value
    .trim()
    .slice(
      0,
      500
    );
}


function cleanClueImageUrl(
  value
) {
  if (
    typeof value !==
      "string"
  ) {
    return "";
  }


  const imageUrl =
    value.trim();


  /*
   * Only images created by BuzzBoard's
   * own uploader may be stored in a game.
   */
  if (
    !/^\/api\/clue-images\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/i.test(
      imageUrl
    )
  ) {
    return "";
  }


  return imageUrl;
}

function cleanClueAudioUrl(
  value
) {
  if (
    typeof value !==
    "string"
  ) {
    return "";
  }


  const audioUrl =
    value.trim();


  /*
   * Only BuzzBoard-owned uploaded
   * audio paths may be stored.
   */
  if (
    !/^\/api\/clue-audio\/[0-9a-f-]{36}\.(mp3|wav|ogg|webm)$/i.test(
      audioUrl
    )
  ) {
    return "";
  }


  return audioUrl;
}

/*
 * --------------------------------
 * GAME CONFIG
 * --------------------------------
 */

function createBlankCategories(
  roundNumber
) {
  const valueMultiplier =
    roundNumber ===
      2
      ? 200
      : 100;

  const categoryPrefix =
    roundNumber ===
      2
      ? "r2-c"
      : "c";

  const categoryLabel =
    roundNumber ===
      2
      ? "Round 2 Category"
      : "Category";

  return Array.from(
    {
      length: 6,
    },

    (
      _,
      categoryIndex
    ) => ({
      id:
        `${categoryPrefix}${categoryIndex}`,

      name:
        `${categoryLabel} ${
          categoryIndex +
          1
        }`,

      clues:
        Array.from(
          {
            length: 5,
          },

          (
            _,
            clueIndex
          ) => ({
            id:
              `${categoryPrefix}${categoryIndex}-q${clueIndex}`,

            value:
              (
                clueIndex +
                1
              ) *
              valueMultiplier,

            question:
              "",

            answer:
              "",

            imageUrl:
              "",

            audioUrl:
              "",

            dailyDouble:
              false,
          })
        ),
    })
  );
}


function normalizeCategories(
  rawCategories,
  roundNumber,
  allowBlankFallback =
    false
) {
  if (
    !Array.isArray(
      rawCategories
    )
  ) {
    return allowBlankFallback
      ? createBlankCategories(
          roundNumber
        )
      : null;
  }

  const valueMultiplier =
    roundNumber ===
      2
      ? 200
      : 100;

  const categoryPrefix =
    roundNumber ===
      2
      ? "r2-c"
      : "c";

  const categoryLabel =
    roundNumber ===
      2
      ? "Round 2 Category"
      : "Category";

  const categories =
    rawCategories
      .slice(
        0,
        6
      )
      .map(
        (
          category,
          categoryIndex
        ) => {
          const rawClues =
            Array.isArray(
              category?.clues
            )
              ? category.clues.slice(
                  0,
                  5
                )
              : [];

          const clues =
            rawClues.map(
              (
                clue,
                clueIndex
              ) => ({
                id:
                  `${categoryPrefix}${categoryIndex}-q${clueIndex}`,

                value:
                  (
                    clueIndex +
                    1
                  ) *
                  valueMultiplier,

                question:
                  cleanText(
                    clue?.question
                  ),

                answer:
                  cleanText(
                    clue?.answer
                  ),

                imageUrl:
                  cleanClueImageUrl(
                    clue?.imageUrl
                  ),

                audioUrl:
                  cleanClueAudioUrl(
                    clue?.audioUrl
                  ),

                dailyDouble:
                  clue?.dailyDouble ===
                  true,
              })
            );

          return {
            id:
              `${categoryPrefix}${categoryIndex}`,

            name:
              cleanText(
                category?.name,

                `${categoryLabel} ${
                  categoryIndex +
                  1
                }`
              ),

            clues,
          };
        }
      );

  if (
    categories.length !==
      6 ||
    categories.some(
      (category) =>
        category.clues
          .length !==
        5
    )
  ) {
    return null;
  }

  return categories;
}


function normalizeGameConfig(
  rawConfig
) {
  const existingId =
    typeof rawConfig?.id ===
      "string" &&
    rawConfig.id.trim()
      ? rawConfig.id
          .trim()
          .slice(
            0,
            100
          )
      : null;

  const title =
    cleanText(
      rawConfig?.title,
      "Untitled Game"
    );

  const categories =
    normalizeCategories(
      rawConfig?.categories,
      1
    );

  /*
   * Existing saved games do not yet
   * contain round2Categories.
   *
   * When that property is absent,
   * generate a blank Round 2 board so
   * the old game loads safely and can
   * be upgraded in the editor.
   */
  const legacyRound2Missing =
    rawConfig
      ?.round2Categories ===
    undefined;

  const round2Categories =
    normalizeCategories(
      rawConfig
        ?.round2Categories,
      2,
      legacyRound2Missing
    );

  if (
    !categories ||
    !round2Categories
  ) {
    return null;
  }

  const finalRound = {
    category:
      cleanText(
        rawConfig
          ?.finalRound
          ?.category,

        "Final Round"
      ),

    question:
      cleanText(
        rawConfig
          ?.finalRound
          ?.question
      ),

    answer:
      cleanText(
        rawConfig
          ?.finalRound
          ?.answer
      ),
  };

  return {
    ...(existingId
      ? {
          id:
            existingId,
        }
      : {}),

    title,
    categories,
    round2Categories,
    finalRound,
  };
}


/*
 * --------------------------------
 * CLUE + BOARD HELPERS
 * --------------------------------
 */

function getClue(
  game,
  categoryId,
  clueId
) {
  const category =
    getRoundCategories(
      game
    ).find(
      (item) =>
        item.id ===
        categoryId
    );

  if (!category) {
    return null;
  }

  const clue =
    category.clues.find(
      (item) =>
        item.id ===
        clueId
    );

  if (!clue) {
    return null;
  }

  return {
    category,
    clue,
  };
}


function makePublicBoard(
  game
) {
  if (
    !game.gameConfig
  ) {
    return null;
  }

  return {
    title:
      game.gameConfig
        .title,

    categories:
      getRoundCategories(
        game
      ).map(
        (category) => ({
          id:
            category.id,

          name:
            category.name,

          clues:
            category.clues.map(
              (clue) => ({
                id:
                  clue.id,

                value:
                  clue.value,
              })
            ),
        })
      ),
  };
}


/*
 * --------------------------------
 * SAVED GAME LIBRARY
 * --------------------------------
 */

function countCategories(
  categories
) {
  return Array.isArray(
    categories
  )
    ? categories.length
    : 0;
}


function countClues(
  categories
) {
  return Array.isArray(
    categories
  )
    ? categories.reduce(
        (
          total,
          category
        ) =>
          total +
          (
            Array.isArray(
              category.clues
            )
              ? category
                  .clues
                  .length
              : 0
          ),

        0
      )
    : 0;
}


function makeLibrarySummary(
  savedGame
) {
  return {
    id:
      savedGame.id,

    title:
      savedGame.title,

    updatedAt:
      savedGame.updatedAt ??
      null,

    categoryCount:
      countCategories(
        savedGame.categories
      ) +
      countCategories(
        savedGame
          .round2Categories
      ),

    clueCount:
      countClues(
        savedGame.categories
      ) +
      countClues(
        savedGame
          .round2Categories
      ),
  };
}


async function sendLibrary(
  socket
) {
  try {
    const savedGames =
      await getSavedGames();

    socket.emit(
      "saved_games",

      savedGames.map(
        makeLibrarySummary
      )
    );
  } catch (error) {
    console.error(
      "Could not list saved games:",
      error
    );

    socket.emit(
      "library_error",
      {
        message:
          "Could not load saved games.",
      }
    );
  }
}


/*
 * --------------------------------
 * FINAL ROUND HELPERS
 * --------------------------------
 */

function getOrCreateFinalSubmission(
  game,
  playerId
) {
  let submission =
    game.finalRound
      .submissions
      .get(
        playerId
      );

  if (!submission) {
    submission = {
      wager:
        null,

      wagerLocked:
        false,

      answer:
        "",

      answerLocked:
        false,

      judged:
        null,
    };

    game.finalRound
      .submissions
      .set(
        playerId,
        submission
      );
  }

  return submission;
}


function allPlayersHaveLockedWagers(
  game
) {
  if (
    game.players.size ===
    0
  ) {
    return false;
  }

  return Array.from(
    game.players.keys()
  ).every(
    (playerId) => {
      const submission =
        game.finalRound
          .submissions
          .get(
            playerId
          );

      return (
        submission
          ?.wagerLocked ===
        true
      );
    }
  );
}


function allPlayersHaveLockedAnswers(
  game
) {
  if (
    game.players.size ===
    0
  ) {
    return false;
  }

  return Array.from(
    game.players.keys()
  ).every(
    (playerId) => {
      const submission =
        game.finalRound
          .submissions
          .get(
            playerId
          );

      return (
        submission
          ?.answerLocked ===
        true
      );
    }
  );
}


function allFinalAnswersJudged(
  game
) {
  if (
    game.players.size ===
    0
  ) {
    return false;
  }

  return Array.from(
    game.players.keys()
  ).every(
    (playerId) => {
      const submission =
        game.finalRound
          .submissions
          .get(
            playerId
          );

      return (
        submission?.judged ===
          true ||
        submission?.judged ===
          false
      );
    }
  );
}


function serializeFinalRoundForSocket(
  game,
  socket
) {
  if (
    !game.gameConfig
      ?.finalRound
  ) {
    return null;
  }

  const isHost =
    socket.data
      .playerId ===
    game.hostId;

  const ownSubmission =
    game.finalRound
      .submissions
      .get(
        socket.data
          .playerId
      );

  const statuses =
    Array.from(
      game.players.values()
    ).map(
      (player) => {
        const submission =
          game.finalRound
            .submissions
            .get(
              player.id
            );

        const base = {
          playerId:
            player.id,

          name:
            player.name,

          wagerLocked:
            submission
              ?.wagerLocked ===
            true,

          answerLocked:
            submission
              ?.answerLocked ===
            true,

          judged:
            submission
              ?.judged ??
            null,
        };

        if (
          game.finalRound
            .answersRevealed
        ) {
          return {
            ...base,

            wager:
              submission
                ?.wager ??
              0,

            answer:
              submission
                ?.answer ??
              "",
          };
        }

        return base;
      }
    );

  return {
    category:
      game.gameConfig
        .finalRound
        .category,

    question:
      game.phase ===
        "final_clue" ||
      game.phase ===
        "final_reveal" ||
      game.phase ===
        "finished"
        ? game.gameConfig
            .finalRound
            .question
        : null,

    correctAnswer:
      isHost &&
      (
        game.phase ===
          "final_reveal" ||
        game.phase ===
          "finished"
      )
        ? game.gameConfig
            .finalRound
            .answer
        : null,

    ownWager:
      ownSubmission
        ?.wager ??
      null,

    ownWagerLocked:
      ownSubmission
        ?.wagerLocked ===
      true,

    ownAnswer:
      ownSubmission
        ?.answer ??
      "",

    ownAnswerLocked:
      ownSubmission
        ?.answerLocked ===
      true,

    allWagersLocked:
      allPlayersHaveLockedWagers(
        game
      ),

    allAnswersLocked:
      allPlayersHaveLockedAnswers(
        game
      ),

    answersRevealed:
      game.finalRound
        .answersRevealed,

    statuses,
  };
}


/*
 * --------------------------------
 * PER-PLAYER GAME STATE
 * --------------------------------
 */

function serializeGameForSocket(
  game,
  socket
) {
  const isHost =
    socket.data
      .playerId ===
    game.hostId;

  return {
    hostId:
      game.hostId,

    phase:
      game.phase,

    currentRound:
      game.currentRound,

    players:
      Array.from(
        game.players.values()
      ),

    board:
      makePublicBoard(
        game
      ),

    editorConfig:
      isHost
        ? game.gameConfig
        : null,

    currentClue:
      game.currentClue
        ? {
            categoryId:
              game.currentClue
                .categoryId,

            categoryName:
              game.currentClue
                .categoryName,

            clueId:
              game.currentClue
                .clueId,

            value:
              game.currentClue
                .value,

            question:
              game.currentClue
                .dailyDouble ===
                true &&
              game.phase !==
                "daily_double_clue"
                ? null
                : game.currentClue
                    .question,

            answer:
              isHost &&
              (
                game.currentClue
                  .dailyDouble !==
                  true ||
                game.phase ===
                  "daily_double_clue"
              )
                ? game.currentClue
                    .answer
                : null,

            imageUrl:
              game.currentClue
                .imageUrl ??
              "",

            audioUrl:
              game.currentClue
                .audioUrl ??
              "",

            dailyDouble:
              game.currentClue
                .dailyDouble ===
              true,
          }
        : null,

    usedClues:
      Array.from(
        game.usedClues
      ),

    buzzer: {
      open:
        game.buzzer.open,

      winner:
        game.buzzer.winner,

      lockedOut:
        Array.from(
          game.buzzer
            .lockedOut
        ),
    },

    dailyDouble: {
      playerId:
        game.dailyDouble
          .playerId,

      wager:
        game.dailyDouble
          .wager,

      wagerLocked:
        game.dailyDouble
          .wagerLocked,

      maxWager:
        game.dailyDouble
          .playerId
          ? getDailyDoubleMaxWager(
              game,

              game.players.get(
                game.dailyDouble
                  .playerId
              )
            )
          : 0,
    },

    timers: {
      buzzerEndsAt:
        game.timers
          .buzzerEndsAt,

      answerEndsAt:
        game.timers
          .answerEndsAt,

      answerType:
        game.timers
          .answerType,

      answerPlayerId:
        game.timers
          .answerPlayerId,

      buzzWindowMs:
        BUZZ_WINDOW_MS,

      answerWindowMs:
        ANSWER_WINDOW_MS,

      dailyDoubleAnswerMs:
        DAILY_DOUBLE_ANSWER_MS,
    },

    hostTools: {
      canUndo:
        Boolean(
          game.undoSnapshot
        ),

      undoLabel:
        game.undoSnapshot
          ?.label ??
        null,
    },
    finalRound:
      serializeFinalRoundForSocket(
        game,
        socket
      ),
  };
}


/*
 * --------------------------------
 * SEND STATE TO EVERY PLAYER
 * --------------------------------
 */

function sendGameState(
  instanceId
) {
  const game =
    games.get(
      instanceId
    );

  if (!game) {
    return;
  }

  const room =
    io.sockets
      .adapter
      .rooms
      .get(
        instanceId
      );

  if (!room) {
    return;
  }

  for (
    const socketId of
    room
  ) {
    const roomSocket =
      io.sockets
        .sockets
        .get(
          socketId
        );

    if (!roomSocket) {
      continue;
    }

    roomSocket.emit(
      "game_state",

      serializeGameForSocket(
        game,
        roomSocket
      )
    );

    roomSocket.emit(
      "host_status",
      {
        isHost:
          roomSocket.data
            .playerId ===
          game.hostId,
      }
    );
  }
}


/*
 * --------------------------------
 * TIMED BUZZER + ANSWER WINDOWS
 * --------------------------------
 */

function startBuzzerWindow(
  game
) {
  clearBuzzerCountdown(
    game
  );

  clearAnswerCountdown(
    game
  );

  game.buzzer.open =
    true;

  game.buzzer.winner =
    null;

  game.timers.buzzerEndsAt =
    Date.now() +
    BUZZ_WINDOW_MS;

  const timeout =
    setTimeout(
      () => {
        const currentGame =
          games.get(
            game.instanceId
          );

        if (
          !currentGame ||
          currentGame !==
            game ||
          game.phase !==
            "clue" ||
          !game.buzzer.open ||
          game.buzzer.winner
        ) {
          return;
        }

        game.buzzer.open =
          false;

        game.timers.buzzerEndsAt =
          null;

        buzzerTimeouts.delete(
          game.instanceId
        );

        console.log(
          `Buzzer window expired: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      },

      BUZZ_WINDOW_MS
    );

  buzzerTimeouts.set(
    game.instanceId,
    timeout
  );
}


function applyNormalIncorrect(
  game,
  wrongPlayerId,
  reason =
    "INCORRECT"
) {
  clearAnswerCountdown(
    game
  );

  const wrongPlayer =
    game.players.get(
      wrongPlayerId
    );

  if (
    !wrongPlayer ||
    !game.currentClue
  ) {
    return false;
  }

  wrongPlayer.score -=
    game.currentClue
      .value;

  game.buzzer
    .lockedOut
    .add(
      wrongPlayer.id
    );

  game.buzzer.winner =
    null;

  const eligiblePlayers =
    Array.from(
      game.players.values()
    ).filter(
      (player) =>
        !game.buzzer
          .lockedOut
          .has(
            player.id
          )
    );

  console.log(
    `${wrongPlayer.name} ${reason} -$${game.currentClue.value}`
  );

  if (
    eligiblePlayers.length >
    0
  ) {
    startBuzzerWindow(
      game
    );
  } else {
    clearBuzzerCountdown(
      game
    );

    game.buzzer.open =
      false;
  }

  return true;
}


function startNormalAnswerWindow(
  game,
  player
) {
  clearBuzzerCountdown(
    game
  );

  clearAnswerCountdown(
    game
  );

  game.buzzer.open =
    false;

  game.timers.answerType =
    "normal";

  game.timers.answerPlayerId =
    player.id;

  game.timers.answerEndsAt =
    Date.now() +
    ANSWER_WINDOW_MS;

  const timeout =
    setTimeout(
      () => {
        const currentGame =
          games.get(
            game.instanceId
          );

        if (
          !currentGame ||
          currentGame !==
            game ||
          game.phase !==
            "clue" ||
          game.buzzer
            .winner
            ?.playerId !==
            player.id
        ) {
          return;
        }

        answerTimeouts.delete(
          game.instanceId
        );

        console.log(
          `ANSWER TIMEOUT: ${player.name}`
        );

        saveUndoSnapshot(
          game,
          "Answer timeout"
        );
        applyNormalIncorrect(
          game,
          player.id,
          "TIMEOUT"
        );

        sendGameState(
          game.instanceId
        );
      },

      ANSWER_WINDOW_MS
    );

  answerTimeouts.set(
    game.instanceId,
    timeout
  );
}


function startDailyDoubleAnswerWindow(
  game,
  player
) {
  clearBuzzerCountdown(
    game
  );

  clearAnswerCountdown(
    game
  );

  game.timers.answerType =
    "daily_double";

  game.timers.answerPlayerId =
    player.id;

  game.timers.answerEndsAt =
    Date.now() +
    DAILY_DOUBLE_ANSWER_MS;

  const timeout =
    setTimeout(
      () => {
        const currentGame =
          games.get(
            game.instanceId
          );

        if (
          !currentGame ||
          currentGame !==
            game ||
          game.phase !==
            "daily_double_clue" ||
          game.dailyDouble
            .playerId !==
            player.id
        ) {
          return;
        }

        answerTimeouts.delete(
          game.instanceId
        );

        const wager =
          game.dailyDouble
            .wager ??
          0;

        saveUndoSnapshot(
          game,
          "Daily Double timeout"
        );
        player.score -=
          wager;

        console.log(
          `${player.name} DAILY DOUBLE TIMEOUT -$${wager}`
        );

        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      },

      DAILY_DOUBLE_ANSWER_MS
    );

  answerTimeouts.set(
    game.instanceId,
    timeout
  );
}


/*
 * --------------------------------
 * ROUND TRANSITIONS
 * --------------------------------
 */

function resetGameForConfig(
  game
) {
  resetRound(
    game
  );
}


function startRoundTwo(
  game
) {
  /*
   * Clear Round 1 board state without
   * resetting any player scores.
   */
  resetBoardState(
    game
  );

  game.currentRound =
    2;

  game.phase =
    "board";

  console.log(
    `Round 2 started: ${game.instanceId}`
  );
}


function startFinalRound(
  game
) {
  clearAllGameTimers(
    game
  );

  game.currentClue =
    null;

  resetBuzzer(
    game
  );

  resetDailyDouble(
    game
  );

  resetFinalRound(
    game
  );

  for (
    const playerId of
    game.players.keys()
  ) {
    getOrCreateFinalSubmission(
      game,
      playerId
    );
  }

  game.phase =
    "final_wager";

  console.log(
    `Final Round started: ${game.instanceId}`
  );
}


function completeCurrentRound(
  game
) {
  if (
    game.currentRound ===
      1
  ) {
    game.phase =
      "round_break";

    console.log(
      `Round 1 complete: ${game.instanceId}`
    );

    return;
  }

  startFinalRound(
    game
  );
}


function finishClue(
  game
) {
  clearAllGameTimers(
    game
  );

  if (
    game.currentClue
  ) {
    game.usedClues.add(
      game.currentClue
        .clueId
    );
  }

  game.currentClue =
    null;

  resetBuzzer(
    game
  );

  resetDailyDouble(
    game
  );

  const realTotalClues =
    getTotalClueCount(
      game
    );

  const cluesNeededToFinish =
    TEST_CLUE_LIMIT ??
    realTotalClues;

  if (
    cluesNeededToFinish >
      0 &&
    game.usedClues.size >=
      cluesNeededToFinish
  ) {
    completeCurrentRound(
      game
    );
  } else {
    game.phase =
      "board";
  }
}


/*
 * --------------------------------
 * SOCKET.IO
 * --------------------------------
 */

io.on(
  "connection",

  (socket) => {
    console.log(
      "Socket connected:",
      socket.id
    );


    /*
     * -----------------------------
     * JOIN GAME
     * -----------------------------
     */

    socket.on(
      "join_game",

      async ({
        instanceId,
        player,
      }) => {
        if (
          !instanceId ||
          !player?.id
        ) {
          return;
        }

        socket.join(
          instanceId
        );

        socket.data.instanceId =
          instanceId;

        socket.data.playerId =
          player.id;

        let game =
          games.get(
            instanceId
          );

        if (!game) {
          game =
            createGame(
              instanceId,
              player
            );
        }

        /*
         * Membership changes are not
         * part of host undo history.
         */
        game.undoSnapshot =
          null;

        const existingPlayer =
          game.players.get(
            player.id
          );

        if (
          existingPlayer
        ) {
          game.players.set(
            player.id,
            {
              ...existingPlayer,
              ...player,
            }
          );
        } else {
          game.players.set(
            player.id,
            {
              ...player,
              score: 0,
            }
          );
        }

        if (
          game.phase.startsWith(
            "final_"
          ) ||
          game.phase ===
            "finished"
        ) {
          getOrCreateFinalSubmission(
            game,
            player.id
          );
        }

        console.log(
          `${player.name} joined ${instanceId}`
        );

        sendGameState(
          instanceId
        );

        if (
          playerIsHost(
            game,
            player.id
          )
        ) {
          await sendLibrary(
            socket
          );
        }
      }
    );


    /*
     * -----------------------------
     * SAVED GAMES
     * -----------------------------
     */

    /*
     * -----------------------------
     * CLUE IMAGE UPLOAD
     * -----------------------------
     *
     * Only the active host may upload,
     * and only while editing in the
     * lobby.
     */

    socket.on(
      "upload_clue_image",

      async (
        payload,
        acknowledge
      ) => {
        const reply =
          typeof acknowledge ===
            "function"
            ? acknowledge
            : () => {};


        const game =
          games.get(
            socket.data
              .instanceId
          );


        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          reply({
            ok:
              false,

            error:
              "Only the host can upload clue images while editing.",
          });

          return;
        }


        const mimeType =
          typeof payload
            ?.mimeType ===
            "string"
            ? payload.mimeType
            : "";


        const rawData =
          payload?.data;


        let contents =
          null;


        /*
         * Socket.IO normally delivers
         * browser binary payloads to
         * Node as Buffer objects, but
         * accept common binary views too.
         */

        if (
          Buffer.isBuffer(
            rawData
          )
        ) {
          contents =
            rawData;
        }
        else if (
          rawData instanceof
            ArrayBuffer
        ) {
          contents =
            Buffer.from(
              rawData
            );
        }
        else if (
          ArrayBuffer.isView(
            rawData
          )
        ) {
          contents =
            Buffer.from(
              rawData.buffer,
              rawData.byteOffset,
              rawData.byteLength
            );
        }


        if (!contents) {
          reply({
            ok:
              false,

            error:
              "No valid image data was received.",
          });

          return;
        }


        if (
          contents.length >
            CLUE_IMAGE_MAX_BYTES
        ) {
          reply({
            ok:
              false,

            error:
              "Image must be 5 MB or smaller.",
          });

          return;
        }


        try {
          const savedImage =
            await saveClueImage(
              contents,
              mimeType
            );


          const imageUrl =
            `/api/clue-images/${
              savedImage.filename
            }`;


          console.log(
            `Clue image uploaded: ${savedImage.filename} (${savedImage.size} bytes)`
          );


          reply({
            ok:
              true,

            imageUrl,

            mimeType:
              savedImage.mimeType,

            size:
              savedImage.size,
          });
        }
        catch (error) {
          console.error(
            "Could not upload clue image:",
            error
          );


          reply({
            ok:
              false,

            error:
              error instanceof
                Error
                ? error.message
                : "Could not upload clue image.",
          });
        }
      }
    );


    /*
     * -----------------------------
     * CLUE AUDIO UPLOAD
     * -----------------------------
     */

    socket.on(
      "upload_clue_audio",

      async (
        payload,
        acknowledge
      ) => {
        const reply =
          typeof acknowledge ===
            "function"
            ? acknowledge
            : () => {};


        const game =
          games.get(
            socket.data
              .instanceId
          );


        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          reply({
            ok:
              false,

            error:
              "Only the host can upload clue audio while editing.",
          });

          return;
        }


        const mimeType =
          typeof payload
            ?.mimeType ===
            "string"
            ? payload.mimeType
            : "";


        const rawData =
          payload?.data;


        let contents =
          null;


        if (
          Buffer.isBuffer(
            rawData
          )
        ) {
          contents =
            rawData;
        }
        else if (
          rawData instanceof
            ArrayBuffer
        ) {
          contents =
            Buffer.from(
              rawData
            );
        }
        else if (
          ArrayBuffer.isView(
            rawData
          )
        ) {
          contents =
            Buffer.from(
              rawData.buffer,
              rawData.byteOffset,
              rawData.byteLength
            );
        }


        if (!contents) {
          reply({
            ok:
              false,

            error:
              "No valid audio data was received.",
          });

          return;
        }


        if (
          contents.length >
          CLUE_AUDIO_MAX_BYTES
        ) {
          reply({
            ok:
              false,

            error:
              "Audio must be 5 MB or smaller.",
          });

          return;
        }


        try {
          const savedAudio =
            await saveClueAudio(
              contents,
              mimeType
            );


          const audioUrl =
            `/api/clue-audio/${
              savedAudio.filename
            }`;


          console.log(
            `Clue audio uploaded: ${savedAudio.filename} (${savedAudio.size} bytes)`
          );


          reply({
            ok:
              true,

            audioUrl,

            mimeType:
              savedAudio.mimeType,

            size:
              savedAudio.size,
          });
        }
        catch (error) {
          console.error(
            "Could not upload clue audio:",
            error
          );


          reply({
            ok:
              false,

            error:
              error instanceof
                Error
                ? error.message
                : "Could not upload clue audio.",
          });
        }
      }
    );

    /*
     * -----------------------------
     * SYNCHRONIZED CLUE AUDIO
     * -----------------------------
     *
     * Only the host may control
     * gameplay audio.
     *
     * Audio may play only while the
     * real clue itself is visible:
     *
     *   clue
     *   daily_double_clue
     *
     * It cannot fire during the
     * Daily Double selection or
     * wagering screens.
     */

    socket.on(
      "control_clue_audio",

      (
        payload
      ) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );


        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          )
        ) {
          return;
        }


        if (
          game.phase !==
            "clue" &&
          game.phase !==
            "daily_double_clue"
        ) {
          return;
        }


        const clue =
          game.currentClue;


        if (
          !clue ||
          typeof clue.audioUrl !==
            "string" ||
          clue.audioUrl.trim() ===
            ""
        ) {
          return;
        }


        const requestedAction =
          typeof payload
            ?.action ===
            "string"
            ? payload.action
            : "";


        if (
          requestedAction !==
            "play" &&
          requestedAction !==
            "replay" &&
          requestedAction !==
            "stop"
        ) {
          return;
        }


        /*
         * Play and replay both restart
         * the clip from 0. Replay is kept
         * as an accepted host command so
         * the UI can label it clearly.
         */
        const broadcastAction =
          requestedAction ===
            "stop"
            ? "stop"
            : "play";


        const commandId =
          `${
            Date.now()
          }-${
            Math.random()
              .toString(
                36
              )
              .slice(
                2,
                10
              )
          }`;


        const command = {
          action:
            broadcastAction,

          requestedAction,

          audioUrl:
            clue.audioUrl,

          clueId:
            clue.clueId,

          commandId,

          issuedAt:
            Date.now(),
        };


        /*
         * Every BuzzBoard participant
         * already occupies the game's
         * instanceId Socket.IO room.
         */
        io.to(
          game.instanceId
        ).emit(
          "clue_audio_command",
          command
        );


        console.log(
          `CLUE AUDIO ${requestedAction.toUpperCase()}: ${game.instanceId} / ${clue.clueId}`
        );
      }
    );

    socket.on(
      "list_saved_games",

      async () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          )
        ) {
          return;
        }

        await sendLibrary(
          socket
        );
      }
    );


    socket.on(
      "save_game_to_library",

      async (
        rawConfig
      ) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          return;
        }

        const normalized =
          normalizeGameConfig(
            rawConfig
          );

        if (
          !normalized
        ) {
          socket.emit(
            "library_error",
            {
              message:
                "BuzzBoard requires six categories with five clues in both Round 1 and Round 2.",
            }
          );

          return;
        }

        try {
          const savedGame =
            await saveGameToLibrary(
              normalized
            );

          game.gameConfig =
            savedGame;

          resetGameForConfig(
            game
          );

          console.log(
            `Saved to library: ${savedGame.title}`
          );

          socket.emit(
            "library_message",
            {
              message:
                `"${savedGame.title}" saved \u2713`,
            }
          );

          sendGameState(
            game.instanceId
          );

          await sendLibrary(
            socket
          );
        } catch (error) {
          console.error(
            "Could not save game:",
            error
          );

          socket.emit(
            "library_error",
            {
              message:
                "Could not save this game.",
            }
          );
        }
      }
    );


    socket.on(
      "load_saved_game",

      async (id) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          return;
        }

        try {
          const savedGame =
            await loadGameFromLibrary(
              id
            );

          if (
            !savedGame
          ) {
            socket.emit(
              "library_error",
              {
                message:
                  "Saved game not found.",
              }
            );

            return;
          }

          const normalized =
            normalizeGameConfig(
              savedGame
            );

          if (
            !normalized
          ) {
            socket.emit(
              "library_error",
              {
                message:
                  "That saved game is invalid.",
              }
            );

            return;
          }

          game.gameConfig = {
            ...normalized,

            id:
              savedGame.id,
          };

          resetGameForConfig(
            game
          );

          console.log(
            `Loaded game: ${savedGame.title}`
          );

          socket.emit(
            "library_message",
            {
              message:
                `"${savedGame.title}" loaded \u2713`,
            }
          );

          sendGameState(
            game.instanceId
          );
        } catch (error) {
          console.error(
            "Could not load game:",
            error
          );

          socket.emit(
            "library_error",
            {
              message:
                "Could not load this game.",
            }
          );
        }
      }
    );


    socket.on(
      "delete_saved_game",

      async (id) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          return;
        }

        try {
          const deleted =
            await deleteGameFromLibrary(
              id
            );

          if (
            !deleted
          ) {
            socket.emit(
              "library_error",
              {
                message:
                  "Saved game not found.",
              }
            );

            return;
          }

          console.log(
            `Deleted saved game: ${id}`
          );

          socket.emit(
            "library_message",
            {
              message:
                "Saved game deleted.",
            }
          );

          await sendLibrary(
            socket
          );
        } catch (error) {
          console.error(
            "Could not delete game:",
            error
          );

          socket.emit(
            "library_error",
            {
              message:
                "Could not delete this game.",
            }
          );
        }
      }
    );


    /*
     * -----------------------------
     * SAVE CURRENT CONFIG
     * -----------------------------
     */

    socket.on(
      "save_game_config",

      (rawConfig) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "lobby"
        ) {
          return;
        }

        const gameConfig =
          normalizeGameConfig(
            rawConfig
          );

        if (
          !gameConfig
        ) {
          socket.emit(
            "editor_error",
            {
              message:
                "BuzzBoard requires six categories with five clues in both Round 1 and Round 2.",
            }
          );

          return;
        }

        game.gameConfig =
          gameConfig;

        resetGameForConfig(
          game
        );

        console.log(
          `Game saved in session: ${gameConfig.title}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * START GAME
     * -----------------------------
     */

    socket.on(
      "start_game",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          !game.gameConfig
        ) {
          return;
        }

        resetRound(
          game
        );

        game.phase =
          "board";

        console.log(
          `Round 1 started: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * START ROUND 2
     * -----------------------------
     */

    socket.on(
      "start_round_2",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "round_break" ||
          game.currentRound !==
            1 ||
          !Array.isArray(
            game.gameConfig
              ?.round2Categories
          )
        ) {
          return;
        }

        startRoundTwo(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * CLUE SELECTION
     * -----------------------------
     */

    socket.on(
      "select_clue",

      ({
        categoryId,
        clueId,
      }) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "board" ||
          game.usedClues.has(
            clueId
          )
        ) {
          return;
        }

        const result =
          getClue(
            game,
            categoryId,
            clueId
          );

        if (!result) {
          return;
        }

        const {
          category,
          clue,
        } =
          result;

        saveUndoSnapshot(
          game,
          "Clue selection"
        );
        game.currentClue = {
          categoryId:
            category.id,

          categoryName:
            category.name,

          clueId:
            clue.id,

          value:
            clue.value,

          question:
            clue.question,

          answer:
            clue.answer,

          imageUrl:
            clue.imageUrl ??
            "",

          audioUrl:
            clue.audioUrl ??
            "",

          dailyDouble:
            clue.dailyDouble ===
            true,
        };

        resetBuzzer(
          game
        );

        resetDailyDouble(
          game
        );

        if (
          clue.dailyDouble ===
          true
        ) {
          game.phase =
            "daily_double_select";

          console.log(
            `DAILY DOUBLE selected: ${category.name} $${clue.value}`
          );
        } else {
          game.phase =
            "clue";

          console.log(
            `Clue selected: ${category.name} $${clue.value}`
          );
        }

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * DAILY DOUBLE
     * -----------------------------
     */

    socket.on(
      "select_daily_double_player",

      (playerId) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "daily_double_select" ||
          !game.currentClue ||
          game.currentClue
            .dailyDouble !==
            true ||
          !game.players.has(
            playerId
          )
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Daily Double contestant"
        );
        game.dailyDouble.playerId =
          playerId;

        game.dailyDouble.wager =
          null;

        game.dailyDouble.wagerLocked =
          false;

        game.phase =
          "daily_double_wager";

        const player =
          game.players.get(
            playerId
          );

        console.log(
          `Daily Double contestant: ${player?.name ?? playerId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "submit_daily_double_wager",

      (rawWager) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const playerId =
          socket.data
            .playerId;

        if (
          !game ||
          game.phase !==
            "daily_double_wager" ||
          game.dailyDouble
            .playerId !==
            playerId ||
          game.dailyDouble
            .wagerLocked
        ) {
          return;
        }

        const player =
          game.players.get(
            playerId
          );

        if (!player) {
          return;
        }

        const numericWager =
          Number(
            rawWager
          );

        if (
          !Number.isFinite(
            numericWager
          )
        ) {
          return;
        }

        const maxWager =
          getDailyDoubleMaxWager(
            game,
            player
          );

        const wager =
          Math.max(
            0,

            Math.min(
              maxWager,

              Math.floor(
                numericWager
              )
            )
          );

        game.dailyDouble.wager =
          wager;

        game.dailyDouble.wagerLocked =
          true;

        game.phase =
          "daily_double_clue";

        console.log(
          `${player.name} locked Daily Double wager: $${wager}`
        );

        startDailyDoubleAnswerWindow(
          game,
          player
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "judge_daily_double_correct",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "daily_double_clue" ||
          !game.currentClue ||
          !game.dailyDouble
            .wagerLocked ||
          game.dailyDouble
            .playerId ===
            null
        ) {
          return;
        }

        const player =
          game.players.get(
            game.dailyDouble
              .playerId
          );

        if (!player) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Daily Double correct"
        );
        clearAnswerCountdown(
          game
        );

        const wager =
          game.dailyDouble
            .wager ??
          0;

        player.score +=
          wager;

        console.log(
          `${player.name} DAILY DOUBLE CORRECT +$${wager}`
        );

        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "judge_daily_double_incorrect",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "daily_double_clue" ||
          !game.currentClue ||
          !game.dailyDouble
            .wagerLocked ||
          game.dailyDouble
            .playerId ===
            null
        ) {
          return;
        }

        const player =
          game.players.get(
            game.dailyDouble
              .playerId
          );

        if (!player) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Daily Double incorrect"
        );
        clearAnswerCountdown(
          game
        );

        const wager =
          game.dailyDouble
            .wager ??
          0;

        player.score -=
          wager;

        console.log(
          `${player.name} DAILY DOUBLE INCORRECT -$${wager}`
        );

        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * NORMAL BUZZER
     * -----------------------------
     */

    socket.on(
      "open_buzzer",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "clue"
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Open buzzers"
        );
        startBuzzerWindow(
          game
        );

        console.log(
          `Buzzers opened: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "buzz",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const playerId =
          socket.data
            .playerId;

        if (
          !game ||
          game.phase !==
            "clue" ||
          !game.buzzer.open ||
          game.buzzer.winner ||
          game.buzzer
            .lockedOut
            .has(
              playerId
            )
        ) {
          return;
        }

        const player =
          game.players.get(
            playerId
          );

        if (!player) {
          return;
        }

        game.buzzer.winner = {
          playerId:
            player.id,

          name:
            player.name,

          receivedAt:
            Date.now(),
        };

        game.buzzer.open =
          false;

        console.log(
          `BUZZ WINNER: ${player.name}`
        );

        startNormalAnswerWindow(
          game,
          player
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "judge_correct",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          !game.currentClue ||
          !game.buzzer
            .winner
        ) {
          return;
        }

        const winner =
          game.players.get(
            game.buzzer
              .winner
              .playerId
          );

        if (!winner) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Correct ruling"
        );
        clearAnswerCountdown(
          game
        );

        winner.score +=
          game.currentClue
            .value;

        console.log(
          `${winner.name} CORRECT +$${game.currentClue.value}`
        );

        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "judge_incorrect",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          !game.currentClue ||
          !game.buzzer
            .winner
        ) {
          return;
        }

        const wrongPlayerId =
          game.buzzer
            .winner
            .playerId;

        saveUndoSnapshot(
          game,
          "Incorrect ruling"
        );
        applyNormalIncorrect(
          game,
          wrongPlayerId,
          "INCORRECT"
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "no_correct_answer",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "clue"
        ) {
          return;
        }

        console.log(
          `No correct answer: ${game.instanceId}`
        );

        saveUndoSnapshot(
          game,
          "End clue"
        );
        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * HOST TOOLS
     * -----------------------------
     */

    socket.on(
      "adjust_score",

      ({
        playerId,
        amount,
      }) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          )
        ) {
          return;
        }

        const player =
          game.players.get(
            playerId
          );

        const numericAmount =
          Number(
            amount
          );

        if (
          !player ||
          !Number.isFinite(
            numericAmount
          )
        ) {
          return;
        }

        const safeAmount =
          Math.max(
            -100_000,

            Math.min(
              100_000,

              Math.trunc(
                numericAmount
              )
            )
          );

        if (
          safeAmount ===
          0
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Score adjustment"
        );

        player.score +=
          safeAmount;

        console.log(
          `HOST SCORE ADJUST: ${player.name} ${safeAmount >= 0 ? "+" : ""}${safeAmount}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "reopen_buzzers",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "clue" ||
          !game.currentClue
        ) {
          return;
        }

        const eligiblePlayers =
          Array.from(
            game.players.values()
          ).filter(
            (player) =>
              !game.buzzer
                .lockedOut
                .has(
                  player.id
                )
          );

        if (
          eligiblePlayers.length ===
          0
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Reopen buzzers"
        );

        clearAnswerCountdown(
          game
        );

        game.buzzer.winner =
          null;

        startBuzzerWindow(
          game
        );

        console.log(
          `HOST REOPENED BUZZERS: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "skip_clue",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const skippablePhases =
          new Set([
            "clue",
            "daily_double_select",
            "daily_double_wager",
            "daily_double_clue",
          ]);

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          !game.currentClue ||
          !skippablePhases.has(
            game.phase
          )
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Skip clue"
        );

        console.log(
          `HOST SKIPPED CLUE: ${game.instanceId}`
        );

        finishClue(
          game
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "undo_last_action",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          !game.undoSnapshot
        ) {
          return;
        }

        const label =
          game.undoSnapshot
            .label;

        const restored =
          restoreUndoSnapshot(
            game
          );

        if (!restored) {
          return;
        }

        console.log(
          `HOST UNDO: ${label}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );
    /*
     * -----------------------------
     * FINAL ROUND
     * -----------------------------
     */

    socket.on(
      "submit_final_wager",

      (rawWager) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const player =
          game?.players.get(
            socket.data
              .playerId
          );

        if (
          !game ||
          !player ||
          game.phase !==
            "final_wager"
        ) {
          return;
        }

        const submission =
          getOrCreateFinalSubmission(
            game,
            player.id
          );

        if (
          submission
            .wagerLocked
        ) {
          return;
        }

        const maxWager =
          Math.max(
            0,

            Math.floor(
              player.score
            )
          );

        const numericWager =
          Number(
            rawWager
          );

        if (
          !Number.isFinite(
            numericWager
          )
        ) {
          return;
        }

        const wager =
          Math.max(
            0,

            Math.min(
              maxWager,

              Math.floor(
                numericWager
              )
            )
          );

        submission.wager =
          wager;

        submission.wagerLocked =
          true;

        console.log(
          `${player.name} locked Final wager`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "reveal_final_clue",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "final_wager" ||
          !allPlayersHaveLockedWagers(
            game
          )
        ) {
          return;
        }

        game.phase =
          "final_clue";

        console.log(
          `Final clue revealed: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "submit_final_answer",

      (rawAnswer) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const player =
          game?.players.get(
            socket.data
              .playerId
          );

        if (
          !game ||
          !player ||
          game.phase !==
            "final_clue"
        ) {
          return;
        }

        const submission =
          getOrCreateFinalSubmission(
            game,
            player.id
          );

        if (
          submission
            .answerLocked
        ) {
          return;
        }

        submission.answer =
          cleanText(
            rawAnswer
          );

        submission.answerLocked =
          true;

        console.log(
          `${player.name} locked Final answer`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "reveal_final_answers",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "final_clue" ||
          !allPlayersHaveLockedAnswers(
            game
          )
        ) {
          return;
        }

        game.phase =
          "final_reveal";

        game.finalRound
          .answersRevealed =
          true;

        console.log(
          `Final answers revealed: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    socket.on(
      "judge_final_answer",

      ({
        playerId,
        correct,
      }) => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          ) ||
          game.phase !==
            "final_reveal"
        ) {
          return;
        }

        const player =
          game.players.get(
            playerId
          );

        const submission =
          game.finalRound
            .submissions
            .get(
              playerId
            );

        if (
          !player ||
          !submission ||
          submission.judged !==
            null
        ) {
          return;
        }

        saveUndoSnapshot(
          game,
          "Final Round ruling"
        );
        const wager =
          submission.wager ??
          0;

        submission.judged =
          Boolean(
            correct
          );

        if (
          submission.judged
        ) {
          player.score +=
            wager;

          console.log(
            `${player.name} FINAL CORRECT +$${wager}`
          );
        } else {
          player.score -=
            wager;

          console.log(
            `${player.name} FINAL INCORRECT -$${wager}`
          );
        }

        if (
          allFinalAnswersJudged(
            game
          )
        ) {
          game.phase =
            "finished";

          console.log(
            `Game finished: ${game.instanceId}`
          );
        }

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * RETURN TO LOBBY
     * -----------------------------
     */

    socket.on(
      "return_to_lobby",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        if (
          !game ||
          !playerIsHost(
            game,
            socket.data
              .playerId
          )
        ) {
          return;
        }

        resetRound(
          game
        );

        game.phase =
          "lobby";

        console.log(
          `Returned to lobby: ${game.instanceId}`
        );

        sendGameState(
          game.instanceId
        );
      }
    );


    /*
     * -----------------------------
     * DISCONNECT / HOST HANDOFF
     * -----------------------------
     */

    socket.on(
      "disconnect",

      () => {
        const game =
          games.get(
            socket.data
              .instanceId
          );

        const playerId =
          socket.data
            .playerId;

        if (!game) {
          return;
        }

        /*
         * Never let undo resurrect a
         * player who has disconnected.
         */
        game.undoSnapshot =
          null;

        const wasBuzzWinner =
          game.buzzer
            .winner
            ?.playerId ===
          playerId;

        game.players.delete(
          playerId
        );

        game.finalRound
          .submissions
          .delete(
            playerId
          );

        if (
          game.dailyDouble
            .playerId ===
          playerId &&
          (
            game.phase ===
              "daily_double_wager" ||
            game.phase ===
              "daily_double_clue"
          )
        ) {
          clearAnswerCountdown(
            game
          );

          resetDailyDouble(
            game
          );

          game.phase =
            "daily_double_select";
        }

        if (
          wasBuzzWinner &&
          game.phase ===
            "clue"
        ) {
          clearAnswerCountdown(
            game
          );

          game.buzzer.winner =
            null;

          const eligiblePlayers =
            Array.from(
              game.players.values()
            ).filter(
              (player) =>
                !game.buzzer
                  .lockedOut
                  .has(
                    player.id
                  )
            );

          if (
            eligiblePlayers.length >
            0
          ) {
            startBuzzerWindow(
              game
            );
          } else {
            game.buzzer.open =
              false;
          }
        }

        if (
          game.players.size ===
          0
        ) {
          clearAllGameTimers(
            game
          );

          games.delete(
            game.instanceId
          );

          return;
        }

        if (
          game.hostId ===
          playerId
        ) {
          const nextHost =
            game.players
              .values()
              .next()
              .value;

          if (nextHost) {
            game.hostId =
              nextHost.id;

            console.log(
              `New host: ${nextHost.name}`
            );
          }
        }

        sendGameState(
          game.instanceId
        );
      }
    );
  }
);


/*
 * --------------------------------
 * START SERVER
 * --------------------------------
 */

httpServer.listen(
  port,

  () => {
    console.log(
      `BuzzBoard server running on http://localhost:${port}`
    );

    console.log(
      `Timers: buzz ${BUZZ_WINDOW_MS / 1000}s, answer ${ANSWER_WINDOW_MS / 1000}s, Daily Double ${DAILY_DOUBLE_ANSWER_MS / 1000}s`
    );

    if (
      TEST_CLUE_LIMIT !==
      null
    ) {
      console.log(
        `TEST MODE: each board completes after ${TEST_CLUE_LIMIT} clues`
      );
    }
  }
);
