import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  io,
  type Socket,
} from "socket.io-client";

import { createDiscordSdk } from "./discord";
import "./App.css";


/*
 * --------------------------------
 * TYPES
 * --------------------------------
 */

type Player = {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  score: number;
};

type PublicClue = {
  id: string;
  value: number;
};

type PublicCategory = {
  id: string;
  name: string;
  clues: PublicClue[];
};

type PublicBoard = {
  title: string;
  categories: PublicCategory[];
};

type EditorClue = {
  id: string;
  value: number;
  question: string;
  answer: string;
  dailyDouble: boolean;
};

type EditorCategory = {
  id: string;
  name: string;
  clues: EditorClue[];
};

type FinalRoundConfig = {
  category: string;
  question: string;
  answer: string;
};

type GameConfig = {
  id?: string;
  title: string;

  /*
   * Round 1 keeps the original
   * categories property so existing
   * saved games remain compatible.
   */
  categories: EditorCategory[];

  round2Categories:
    EditorCategory[];

  finalRound: FinalRoundConfig;
};

type CurrentClue = {
  categoryId: string;
  categoryName: string;
  clueId: string;
  value: number;
  question: string | null;
  answer: string | null;
  dailyDouble: boolean;
};

type BuzzWinner = {
  playerId: string;
  name: string;
  receivedAt: number;
};

type SavedGameSummary = {
  id: string;
  title: string;
  updatedAt: string | null;
  categoryCount: number;
  clueCount: number;
};

type FinalPlayerStatus = {
  playerId: string;
  name: string;
  wagerLocked: boolean;
  answerLocked: boolean;
  judged: boolean | null;

  wager?: number;
  answer?: string;
};

type FinalRoundState = {
  category: string;

  question:
    | string
    | null;

  correctAnswer:
    | string
    | null;

  ownWager:
    | number
    | null;

  ownWagerLocked:
    boolean;

  ownAnswer:
    string;

  ownAnswerLocked:
    boolean;

  allWagersLocked:
    boolean;

  allAnswersLocked:
    boolean;

  answersRevealed:
    boolean;

  statuses:
    FinalPlayerStatus[];
};

type TimerState = {
  buzzerEndsAt:
    | number
    | null;

  answerEndsAt:
    | number
    | null;

  answerType:
    | "normal"
    | "daily_double"
    | null;

  answerPlayerId:
    | string
    | null;

  buzzWindowMs:
    number;

  answerWindowMs:
    number;

  dailyDoubleAnswerMs:
    number;
};

type HostToolsState = {
  canUndo: boolean;

  undoLabel:
    | string
    | null;
};

type GameState = {
  hostId: string;

  phase:
    | "lobby"
    | "board"
    | "clue"
    | "daily_double_select"
    | "daily_double_wager"
    | "daily_double_clue"
    | "round_break"
    | "final_wager"
    | "final_clue"
    | "final_reveal"
    | "finished";

  currentRound:
    1 | 2;

  players: Player[];

  board:
    | PublicBoard
    | null;

  editorConfig:
    | GameConfig
    | null;

  currentClue:
    | CurrentClue
    | null;

  usedClues: string[];

  buzzer: {
    open: boolean;

    winner:
      | BuzzWinner
      | null;

    lockedOut: string[];
  };

  dailyDouble: {
    playerId:
      | string
      | null;

    wager:
      | number
      | null;

    wagerLocked:
      boolean;

    maxWager:
      number;
  };

  timers:
    TimerState;

  hostTools:
    HostToolsState;

  finalRound:
    | FinalRoundState
    | null;
};


type AudioCue =
  | "ready"
  | "buzz"
  | "correct"
  | "incorrect"
  | "daily_double"
  | "final"
  | "tick"
  | "complete";


type FeedbackKind =
  | "ready"
  | "buzz"
  | "correct"
  | "incorrect"
  | "daily_double"
  | "final"
  | "complete";


type FeedbackState = {
  kind:
    FeedbackKind;

  label:
    string;

  id:
    number;
};


/*
 * --------------------------------
 * DEFAULT GAME
 * --------------------------------
 */

function createBlankCategories(
  round:
    1 | 2
): EditorCategory[] {
  const multiplier =
    round ===
      2
      ? 200
      : 100;

  const prefix =
    round ===
      2
      ? "r2-c"
      : "c";

  const label =
    round ===
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
        `${prefix}${categoryIndex}`,

      name:
        `${label} ${
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
              `${prefix}${categoryIndex}-q${clueIndex}`,

            value:
              (
                clueIndex +
                1
              ) *
              multiplier,

            question:
              "",

            answer:
              "",

            dailyDouble:
              false,
          })
        ),
    })
  );
}


function createBlankGameConfig(): GameConfig {
  return {
    title:
      "My BuzzBoard Game",

    categories:
      createBlankCategories(
        1
      ),

    round2Categories:
      createBlankCategories(
        2
      ),

    finalRound: {
      category:
        "Final Round",

      question:
        "",

      answer:
        "",
    },
  };
}


const initialGameState: GameState = {
  hostId:
    "",

  phase:
    "lobby",

  currentRound:
    1,

  players:
    [],

  board:
    null,

  editorConfig:
    null,

  currentClue:
    null,

  usedClues:
    [],

  buzzer: {
    open:
      false,

    winner:
      null,

    lockedOut:
      [],
  },

  dailyDouble: {
    playerId:
      null,

    wager:
      null,

    wagerLocked:
      false,

    maxWager:
      0,
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

    buzzWindowMs:
      10_000,

    answerWindowMs:
      8_000,

    dailyDoubleAnswerMs:
      12_000,
  },

  hostTools: {
    canUndo:
      false,

    undoLabel:
      null,
  },

  finalRound:
    null,
};


/*
 * --------------------------------
 * FORMATTING HELPERS
 * --------------------------------
 */

function formatScore(
  score: number
) {
  if (
    score < 0
  ) {
    return `-$${Math.abs(
      score
    )}`;
  }

  return `$${score}`;
}


function formatSavedDate(
  updatedAt:
    | string
    | null
) {
  if (
    !updatedAt
  ) {
    return "Saved game";
  }

  const date =
    new Date(
      updatedAt
    );

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "Saved game";
  }

  return date
    .toLocaleString();
}


function formatCountdown(
  endTime:
    | number
    | null,

  now:
    number
) {
  if (
    endTime ===
    null
  ) {
    return null;
  }

  const remaining =
    Math.max(
      0,
      (
        endTime -
        now
      ) /
      1000
    );

  return remaining
    .toFixed(
      1
    );
}


/*
 * --------------------------------
 * WEB AUDIO HELPERS
 * --------------------------------
 */

function scheduleTone(
  context:
    AudioContext,

  frequency:
    number,

  startTime:
    number,

  duration:
    number,

  volume:
    number,

  wave:
    OscillatorType =
      "sine"
) {
  const oscillator =
    context
      .createOscillator();

  const gain =
    context
      .createGain();

  oscillator.type =
    wave;

  oscillator.frequency
    .setValueAtTime(
      frequency,
      startTime
    );

  gain.gain
    .setValueAtTime(
      0.0001,
      startTime
    );

  gain.gain
    .exponentialRampToValueAtTime(
      Math.max(
        0.0001,
        volume
      ),

      startTime +
      0.012
    );

  gain.gain
    .exponentialRampToValueAtTime(
      0.0001,

      startTime +
      duration
    );

  oscillator.connect(
    gain
  );

  gain.connect(
    context.destination
  );

  oscillator.start(
    startTime
  );

  oscillator.stop(
    startTime +
    duration +
    0.03
  );
}


function playAudioCue(
  context:
    AudioContext,

  cue:
    AudioCue
) {
  const now =
    context.currentTime +
    0.01;

  switch (
    cue
  ) {
    case "ready":
      scheduleTone(
        context,
        523.25,
        now,
        0.11,
        0.08,
        "triangle"
      );

      scheduleTone(
        context,
        659.25,
        now + 0.12,
        0.13,
        0.09,
        "triangle"
      );

      break;


    case "buzz":
      scheduleTone(
        context,
        880,
        now,
        0.09,
        0.11,
        "square"
      );

      scheduleTone(
        context,
        1174.66,
        now + 0.075,
        0.18,
        0.09,
        "triangle"
      );

      break;


    case "correct":
      scheduleTone(
        context,
        523.25,
        now,
        0.12,
        0.08,
        "triangle"
      );

      scheduleTone(
        context,
        659.25,
        now + 0.1,
        0.14,
        0.09,
        "triangle"
      );

      scheduleTone(
        context,
        783.99,
        now + 0.2,
        0.2,
        0.1,
        "triangle"
      );

      break;


    case "incorrect":
      scheduleTone(
        context,
        329.63,
        now,
        0.16,
        0.08,
        "sawtooth"
      );

      scheduleTone(
        context,
        246.94,
        now + 0.13,
        0.25,
        0.08,
        "sawtooth"
      );

      break;


    case "daily_double":
      scheduleTone(
        context,
        392,
        now,
        0.18,
        0.07,
        "triangle"
      );

      scheduleTone(
        context,
        523.25,
        now + 0.13,
        0.18,
        0.08,
        "triangle"
      );

      scheduleTone(
        context,
        659.25,
        now + 0.26,
        0.2,
        0.09,
        "triangle"
      );

      scheduleTone(
        context,
        783.99,
        now + 0.39,
        0.34,
        0.09,
        "triangle"
      );

      break;


    case "final":
      scheduleTone(
        context,
        261.63,
        now,
        0.22,
        0.06,
        "sine"
      );

      scheduleTone(
        context,
        392,
        now + 0.16,
        0.25,
        0.075,
        "sine"
      );

      scheduleTone(
        context,
        523.25,
        now + 0.33,
        0.4,
        0.08,
        "sine"
      );

      break;


    case "tick":
      scheduleTone(
        context,
        1046.5,
        now,
        0.055,
        0.035,
        "square"
      );

      break;


    case "complete":
      scheduleTone(
        context,
        523.25,
        now,
        0.16,
        0.07,
        "triangle"
      );

      scheduleTone(
        context,
        659.25,
        now + 0.12,
        0.18,
        0.08,
        "triangle"
      );

      scheduleTone(
        context,
        783.99,
        now + 0.24,
        0.2,
        0.09,
        "triangle"
      );

      scheduleTone(
        context,
        1046.5,
        now + 0.38,
        0.45,
        0.1,
        "triangle"
      );

      break;
  }
}


/*
 * --------------------------------
 * APP
 * --------------------------------
 */

function App() {
  const [
    status,
    setStatus,
  ] =
    useState(
      "Starting BuzzBoard..."
    );

  const [
    isHost,
    setIsHost,
  ] =
    useState(
      false
    );

  const [
    currentUserId,
    setCurrentUserId,
  ] =
    useState<
      string | null
    >(
      null
    );

  const [
    gameState,
    setGameState,
  ] =
    useState<GameState>(
      initialGameState
    );

  const [
    editorConfig,
    setEditorConfig,
  ] =
    useState<GameConfig>(
      createBlankGameConfig
    );

  const [
    editorMessage,
    setEditorMessage,
  ] =
    useState(
      ""
    );

  const [
    editorDirty,
    setEditorDirty,
  ] =
    useState(
      false
    );

  const [
    savedGames,
    setSavedGames,
  ] =
    useState<
      SavedGameSummary[]
    >(
      []
    );

  const [
    libraryMessage,
    setLibraryMessage,
  ] =
    useState(
      ""
    );

  const [
    finalWagerInput,
    setFinalWagerInput,
  ] =
    useState(
      ""
    );

  const [
    finalAnswerInput,
    setFinalAnswerInput,
  ] =
    useState(
      ""
    );

  const [
    dailyDoubleWagerInput,
    setDailyDoubleWagerInput,
  ] =
    useState(
      ""
    );

  const [
    hostSelectedPlayerId,
    setHostSelectedPlayerId,
  ] =
    useState(
      ""
    );

  const [
    hostScoreAmount,
    setHostScoreAmount,
  ] =
    useState(
      "100"
    );

  const [
    clockNow,
    setClockNow,
  ] =
    useState(
      Date.now()
    );

  const [
    soundEnabled,
    setSoundEnabled,
  ] =
    useState(
      () => {
        try {
          return (
            window
              .localStorage
              .getItem(
                "buzzboard-sound-enabled"
              ) !==
            "false"
          );
        } catch {
          return true;
        }
      }
    );

  const [
    feedback,
    setFeedback,
  ] =
    useState<
      FeedbackState | null
    >(
      null
    );

  const socketRef =
    useRef<
      Socket | null
    >(
      null
    );

  const editorDirtyRef =
    useRef(
      false
    );

  const awaitingLibrarySyncRef =
    useRef(
      false
    );

  const audioContextRef =
    useRef<
      AudioContext | null
    >(
      null
    );

  const previousGameStateRef =
    useRef<
      GameState | null
    >(
      null
    );

  const feedbackTimeoutRef =
    useRef<
      number | null
    >(
      null
    );

  const lastUrgencyTickRef =
    useRef<
      number | null
    >(
      null
    );


  /*
   * SECTION 2 CONTINUES HERE
   */

  /*
   * --------------------------------
   * AUDIO CONTEXT
   * --------------------------------
   */

  function ensureAudioContext() {
    if (
      audioContextRef.current
    ) {
      return audioContextRef.current;
    }

    if (
      typeof AudioContext ===
      "undefined"
    ) {
      return null;
    }

    try {
      const context =
        new AudioContext();

      audioContextRef.current =
        context;

      return context;
    } catch (
      error
    ) {
      console.warn(
        "BuzzBoard audio could not start:",
        error
      );

      return null;
    }
  }


  function playCue(
    cue:
      AudioCue
  ) {
    if (
      !soundEnabled
    ) {
      return;
    }

    const context =
      ensureAudioContext();

    if (
      !context
    ) {
      return;
    }

    const play =
      () => {
        try {
          playAudioCue(
            context,
            cue
          );
        } catch (
          error
        ) {
          console.warn(
            "BuzzBoard sound failed:",
            error
          );
        }
      };


    if (
      context.state ===
      "suspended"
    ) {
      context
        .resume()
        .then(
          play
        )
        .catch(
          () => {
            /*
             * Mobile browsers may
             * refuse audio until the
             * next user interaction.
             */
          }
        );

      return;
    }

    play();
  }


  /*
   * --------------------------------
   * SOUND PREFERENCE
   * --------------------------------
   */

  useEffect(
    () => {
      try {
        window
          .localStorage
          .setItem(
            "buzzboard-sound-enabled",

            soundEnabled
              ? "true"
              : "false"
          );
      } catch {
        /*
         * Local storage is optional.
         */
      }
    },

    [
      soundEnabled,
    ]
  );


  function toggleSound() {
    if (
      soundEnabled
    ) {
      setSoundEnabled(
        false
      );

      return;
    }

    setSoundEnabled(
      true
    );

    const context =
      ensureAudioContext();

    if (
      !context
    ) {
      return;
    }

    const confirmSound =
      () => {
        playAudioCue(
          context,
          "ready"
        );
      };

    if (
      context.state ===
      "suspended"
    ) {
      context
        .resume()
        .then(
          confirmSound
        )
        .catch(
          () => {}
        );
    } else {
      confirmSound();
    }
  }


  /*
   * --------------------------------
   * MOBILE / BROWSER AUDIO UNLOCK
   * --------------------------------
   */

  useEffect(
    () => {
      function unlockAudio() {
        if (
          !soundEnabled
        ) {
          return;
        }

        const context =
          ensureAudioContext();

        if (
          !context ||
          context.state !==
            "suspended"
        ) {
          return;
        }

        context
          .resume()
          .catch(
            () => {}
          );
      }


      window.addEventListener(
        "pointerdown",
        unlockAudio,
        {
          passive: true,
        }
      );

      window.addEventListener(
        "keydown",
        unlockAudio
      );


      return () => {
        window.removeEventListener(
          "pointerdown",
          unlockAudio
        );

        window.removeEventListener(
          "keydown",
          unlockAudio
        );
      };
    },

    [
      soundEnabled,
    ]
  );


  /*
   * --------------------------------
   * VISUAL FEEDBACK
   * --------------------------------
   */

  function showFeedback(
    kind:
      FeedbackKind,

    label:
      string,

    duration =
      850
  ) {
    if (
      feedbackTimeoutRef.current !==
      null
    ) {
      window.clearTimeout(
        feedbackTimeoutRef.current
      );
    }

    setFeedback({
      kind,
      label,

      id:
        Date.now(),
    });

    feedbackTimeoutRef.current =
      window.setTimeout(
        () => {
          setFeedback(
            null
          );

          feedbackTimeoutRef.current =
            null;
        },

        duration
      );
  }


  /*
   * Expose visual feedback through
   * body data attributes so every
   * game screen can share the same
   * full-screen effect without
   * duplicating JSX.
   */

  useEffect(
    () => {
      if (
        feedback
      ) {
        document.body.dataset
          .feedback =
          feedback.kind;

        document.body.dataset
          .feedbackLabel =
          feedback.label;
      } else {
        delete document.body
          .dataset
          .feedback;

        delete document.body
          .dataset
          .feedbackLabel;
      }


      return () => {
        delete document.body
          .dataset
          .feedback;

        delete document.body
          .dataset
          .feedbackLabel;
      };
    },

    [
      feedback,
    ]
  );


  /*
   * --------------------------------
   * FEEDBACK CLEANUP
   * --------------------------------
   */

  useEffect(
    () => {
      return () => {
        if (
          feedbackTimeoutRef.current !==
          null
        ) {
          window.clearTimeout(
            feedbackTimeoutRef.current
          );
        }

        const context =
          audioContextRef.current;

        if (
          context &&
          context.state !==
            "closed"
        ) {
          context
            .close()
            .catch(
              () => {}
            );
        }
      };
    },

    []
  );


  /*
   * --------------------------------
   * SYNCHRONIZED COUNTDOWN CLOCK
   * --------------------------------
   */

  useEffect(
    () => {
      const hasActiveTimer =
        gameState
          .timers
          .buzzerEndsAt !==
          null ||
        gameState
          .timers
          .answerEndsAt !==
          null;

      if (
        !hasActiveTimer
      ) {
        setClockNow(
          Date.now()
        );

        return;
      }

      setClockNow(
        Date.now()
      );

      const interval =
        window.setInterval(
          () => {
            setClockNow(
              Date.now()
            );
          },

          100
        );

      return () => {
        window.clearInterval(
          interval
        );
      };
    },

    [
      gameState
        .timers
        .buzzerEndsAt,

      gameState
        .timers
        .answerEndsAt,
    ]
  );


  /*
   * --------------------------------
   * 3... 2... 1 URGENCY TICKS
   * --------------------------------
   */

  useEffect(
    () => {
      const endTime =
        gameState
          .timers
          .answerEndsAt ??
        gameState
          .timers
          .buzzerEndsAt;

      if (
        endTime ===
        null
      ) {
        lastUrgencyTickRef.current =
          null;

        return;
      }

      const remainingSeconds =
        Math.ceil(
          (
            endTime -
            clockNow
          ) /
          1000
        );

      if (
        remainingSeconds >
        3
      ) {
        lastUrgencyTickRef.current =
          null;

        return;
      }

      if (
        remainingSeconds <=
          0 ||
        remainingSeconds >
          3
      ) {
        return;
      }

      if (
        lastUrgencyTickRef.current ===
        remainingSeconds
      ) {
        return;
      }

      lastUrgencyTickRef.current =
        remainingSeconds;

      playCue(
        "tick"
      );
    },

    [
      clockNow,

      gameState
        .timers
        .buzzerEndsAt,

      gameState
        .timers
        .answerEndsAt,

      soundEnabled,
    ]
  );


  /*
   * --------------------------------
   * SERVER STATE -> FEEDBACK EVENTS
   * --------------------------------
   */

  useEffect(
    () => {
      const previous =
        previousGameStateRef.current;

      if (
        !previous
      ) {
        previousGameStateRef.current =
          gameState;

        return;
      }


      let rulingFeedbackPlayed =
        false;


      /*
       * DAILY DOUBLE DISCOVERED
       */

      if (
        gameState.phase ===
          "daily_double_select" &&
        previous.phase !==
          "daily_double_select"
      ) {
        playCue(
          "daily_double"
        );

        showFeedback(
          "daily_double",
          "✨ DAILY DOUBLE ✨",
          1200
        );
      }


      /*
       * NORMAL INCORRECT / TIMEOUT
       *
       * A wrong player disappears
       * as winner and becomes locked.
       */

      const previousWinnerId =
        previous.buzzer
          .winner
          ?.playerId ??
        null;

      if (
        previousWinnerId &&
        !gameState
          .buzzer
          .winner &&
        gameState.phase ===
          "clue" &&
        gameState
          .buzzer
          .lockedOut
          .includes(
            previousWinnerId
          ) &&
        !previous
          .buzzer
          .lockedOut
          .includes(
            previousWinnerId
          )
      ) {
        rulingFeedbackPlayed =
          true;

        playCue(
          "incorrect"
        );

        showFeedback(
          "incorrect",
          "✕ INCORRECT",
          850
        );
      }


      /*
       * NORMAL CORRECT
       *
       * The clue closes and the
       * previous winner gained points.
       */

      if (
        previous.phase ===
          "clue" &&
        gameState.phase !==
          "clue" &&
        previous
          .currentClue &&
        previous
          .buzzer
          .winner
      ) {
        const winnerId =
          previous
            .buzzer
            .winner
            .playerId;

        const oldWinner =
          previous.players.find(
            (
              player
            ) =>
              player.id ===
              winnerId
          );

        const newWinner =
          gameState.players.find(
            (
              player
            ) =>
              player.id ===
              winnerId
          );

        const scoreChange =
          (
            newWinner
              ?.score ??
            0
          ) -
          (
            oldWinner
              ?.score ??
            0
          );

        if (
          scoreChange >
          0
        ) {
          rulingFeedbackPlayed =
            true;

          playCue(
            "correct"
          );

          showFeedback(
            "correct",
            "✓ CORRECT",
            850
          );
        }
      }


      /*
       * DAILY DOUBLE RULING / TIMEOUT
       */

      if (
        previous.phase ===
          "daily_double_clue" &&
        gameState.phase !==
          "daily_double_clue" &&
        previous
          .dailyDouble
          .playerId
      ) {
        const playerId =
          previous
            .dailyDouble
            .playerId;

        const oldPlayer =
          previous.players.find(
            (
              player
            ) =>
              player.id ===
              playerId
          );

        const newPlayer =
          gameState.players.find(
            (
              player
            ) =>
              player.id ===
              playerId
          );

        const scoreChange =
          (
            newPlayer
              ?.score ??
            0
          ) -
          (
            oldPlayer
              ?.score ??
            0
          );

        if (
          scoreChange >
          0
        ) {
          rulingFeedbackPlayed =
            true;

          playCue(
            "correct"
          );

          showFeedback(
            "correct",
            "✓ DAILY DOUBLE CORRECT",
            950
          );
        } else if (
          scoreChange <
          0
        ) {
          rulingFeedbackPlayed =
            true;

          playCue(
            "incorrect"
          );

          showFeedback(
            "incorrect",
            "✕ DAILY DOUBLE",
            950
          );
        }
      }


      /*
       * BUZZERS OPEN
       *
       * If they reopened because of
       * an incorrect ruling, let the
       * incorrect stinger own that
       * moment rather than playing
       * two sounds simultaneously.
       */

      if (
        !previous
          .buzzer
          .open &&
        gameState
          .buzzer
          .open &&
        gameState.phase ===
          "clue" &&
        !rulingFeedbackPlayed
      ) {
        playCue(
          "ready"
        );

        showFeedback(
          "ready",
          "🔴 BUZZERS OPEN",
          650
        );
      }


      /*
       * PLAYER BUZZED FIRST
       */

      if (
        gameState
          .buzzer
          .winner &&
        previous
          .buzzer
          .winner
          ?.playerId !==
          gameState
            .buzzer
            .winner
            .playerId
      ) {
        playCue(
          "buzz"
        );

        showFeedback(
          "buzz",

          `🔔 ${
            gameState
              .buzzer
              .winner
              .name
          }`,

          750
        );
      }


      /*
       * FINAL ROUND BEGINS
       */

      if (
        gameState.phase ===
          "final_wager" &&
        previous.phase !==
          "final_wager"
      ) {
        const triggerFinal =
          () => {
            playCue(
              "final"
            );

            showFeedback(
              "final",
              "🏆 FINAL ROUND",
              1200
            );
          };


        if (
          rulingFeedbackPlayed
        ) {
          window.setTimeout(
            triggerFinal,
            650
          );
        } else {
          triggerFinal();
        }
      }


      /*
       * FINAL ROUND JUDGING
       *
       * Intermediate judgements get
       * correct / incorrect feedback.
       * The final judgement instead
       * gets the game-complete cue.
       */

      if (
        previous.phase ===
          "final_reveal" &&
        gameState.phase ===
          "final_reveal" &&
        previous.finalRound &&
        gameState.finalRound
      ) {
        const newlyJudged =
          gameState
            .finalRound
            .statuses
            .find(
              (
                player
              ) => {
                const oldStatus =
                  previous
                    .finalRound
                    ?.statuses
                    .find(
                      (
                        oldPlayer
                      ) =>
                        oldPlayer
                          .playerId ===
                        player.playerId
                    );

                return (
                  oldStatus
                    ?.judged ===
                    null &&
                  player.judged !==
                    null
                );
              }
            );

        if (
          newlyJudged
            ?.judged ===
          true
        ) {
          playCue(
            "correct"
          );

          showFeedback(
            "correct",
            "✓ CORRECT",
            850
          );
        }

        if (
          newlyJudged
            ?.judged ===
          false
        ) {
          playCue(
            "incorrect"
          );

          showFeedback(
            "incorrect",
            "✕ INCORRECT",
            850
          );
        }
      }


      /*
       * GAME COMPLETE
       */

      if (
        gameState.phase ===
          "finished" &&
        previous.phase !==
          "finished"
      ) {
        playCue(
          "complete"
        );

        showFeedback(
          "complete",
          "🏆 GAME COMPLETE",
          1500
        );
      }


      previousGameStateRef.current =
        gameState;
    },

    [
      gameState,
      soundEnabled,
    ]
  );


  /*
   * --------------------------------
   * HOST PLAYER SELECTOR SYNC
   * --------------------------------
   */

  useEffect(
    () => {
      if (
        gameState.players.length ===
        0
      ) {
        setHostSelectedPlayerId(
          ""
        );

        return;
      }

      const selectedStillExists =
        gameState.players.some(
          (
            player
          ) =>
            player.id ===
            hostSelectedPlayerId
        );

      if (
        !selectedStillExists
      ) {
        setHostSelectedPlayerId(
          gameState.players[0].id
        );
      }
    },

    [
      gameState.players,
      hostSelectedPlayerId,
    ]
  );


  /*
   * --------------------------------
   * DIRTY / CLEAN EDITOR
   * --------------------------------
   */

  function setDirty(
    message =
      "Unsaved changes"
  ) {
    editorDirtyRef.current =
      true;

    setEditorDirty(
      true
    );

    setEditorMessage(
      message
    );
  }


  function setClean() {
    editorDirtyRef.current =
      false;

    setEditorDirty(
      false
    );
  }


  /*
   * SECTION 3 CONTINUES HERE
   */

  /*
   * --------------------------------
   * DISCORD + SOCKET.IO SETUP
   * --------------------------------
   */

  useEffect(
    () => {
      let active =
        true;

      async function setupBuzzBoard() {
        try {
          const discordSdk =
            createDiscordSdk();

          await discordSdk.ready();

          if (
            !active
          ) {
            return;
          }

          setStatus(
            "Connected to Discord. Authorizing..."
          );

          const {
            code,
          } =
            await discordSdk
              .commands
              .authorize({
                client_id:
                  import.meta
                    .env
                    .VITE_DISCORD_CLIENT_ID,

                response_type:
                  "code",

                state:
                  "",

                prompt:
                  "none",

                scope: [
                  "identify",
                ],
              });

          const tokenResponse =
            await fetch(
              "/api/token",

              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    code,
                  }),
              }
            );

          const tokenData =
            await tokenResponse
              .json();

          if (
            !tokenResponse.ok
          ) {
            throw new Error(
              tokenData
                .error_description ??
                tokenData
                  .error ??
                "Could not retrieve Discord access token"
            );
          }

          if (
            !tokenData
              .access_token
          ) {
            throw new Error(
              "Discord did not return an access token"
            );
          }

          const auth =
            await discordSdk
              .commands
              .authenticate({
                access_token:
                  tokenData
                    .access_token,
              });

          if (
            auth == null
          ) {
            throw new Error(
              "Discord authentication failed"
            );
          }

          if (
            !active
          ) {
            return;
          }

          const player = {
            id:
              auth.user.id,

            name:
              auth.user
                .global_name ??
              auth.user
                .username,

            username:
              auth.user
                .username,

            avatar:
              auth.user
                .avatar ??
              null,
          };

          setCurrentUserId(
            player.id
          );

          setStatus(
            "Connecting to game server..."
          );

          const socket =
            io({
              autoConnect:
                false,
            });

          socketRef.current =
            socket;


          /*
           * SOCKET CONNECT
           */

          socket.on(
            "connect",

            () => {
              if (
                !active
              ) {
                return;
              }

              setStatus(
                "Ready to play! ✓"
              );

              socket.emit(
                "join_game",

                {
                  instanceId:
                    discordSdk
                      .instanceId,

                  player,
                }
              );
            }
          );


          /*
           * GAME STATE
           */

          socket.on(
            "game_state",

            (
              state:
                GameState
            ) => {
              if (
                !active
              ) {
                return;
              }

              setGameState(
                state
              );


              /*
               * Synchronize the
               * host editor.
               */

              if (
                state.editorConfig &&
                (
                  awaitingLibrarySyncRef
                    .current ||
                  !editorDirtyRef
                    .current
                )
              ) {
                setEditorConfig(
                  state
                    .editorConfig
                );

                awaitingLibrarySyncRef
                  .current =
                  false;

                setClean();
              }


              /*
               * Clear local form fields
               * whenever we return to
               * the lobby or board.
               */

              if (
                state.phase ===
                  "lobby" ||
                state.phase ===
                  "board"
              ) {
                setFinalWagerInput(
                  ""
                );

                setFinalAnswerInput(
                  ""
                );

                setDailyDoubleWagerInput(
                  ""
                );
              }


              /*
               * Restore locked Daily
               * Double wager after a
               * reconnect / state sync.
               */

              if (
                state.dailyDouble
                  .wagerLocked &&
                state.dailyDouble
                  .wager !==
                  null
              ) {
                setDailyDoubleWagerInput(
                  String(
                    state
                      .dailyDouble
                      .wager
                  )
                );
              }


              /*
               * Restore Final Round
               * values after reconnect.
               */

              if (
                state.finalRound
                  ?.ownWagerLocked &&
                state.finalRound
                  .ownWager !==
                  null
              ) {
                setFinalWagerInput(
                  String(
                    state
                      .finalRound
                      .ownWager
                  )
                );
              }

              if (
                state.finalRound
                  ?.ownAnswerLocked
              ) {
                setFinalAnswerInput(
                  state
                    .finalRound
                    .ownAnswer
                );
              }
            }
          );


          /*
           * HOST STATUS
           */

          socket.on(
            "host_status",

            (
              data: {
                isHost:
                  boolean;
              }
            ) => {
              if (
                !active
              ) {
                return;
              }

              setIsHost(
                data.isHost
              );

              if (
                data.isHost
              ) {
                socket.emit(
                  "list_saved_games"
                );
              }
            }
          );


          /*
           * EDITOR EVENTS
           */

          socket.on(
            "editor_error",

            (
              data: {
                message:
                  string;
              }
            ) => {
              if (
                !active
              ) {
                return;
              }

              setEditorMessage(
                data.message
              );
            }
          );


          /*
           * SAVED GAMES
           */

          socket.on(
            "saved_games",

            (
              games:
                SavedGameSummary[]
            ) => {
              if (
                !active
              ) {
                return;
              }

              setSavedGames(
                games
              );
            }
          );


          socket.on(
            "library_message",

            (
              data: {
                message:
                  string;
              }
            ) => {
              if (
                !active
              ) {
                return;
              }

              setLibraryMessage(
                data.message
              );
            }
          );


          socket.on(
            "library_error",

            (
              data: {
                message:
                  string;
              }
            ) => {
              if (
                !active
              ) {
                return;
              }

              awaitingLibrarySyncRef
                .current =
                false;

              setLibraryMessage(
                data.message
              );
            }
          );


          /*
           * SOCKET ERRORS
           */

          socket.on(
            "connect_error",

            (
              error
            ) => {
              console.error(
                "Socket connection error:",
                error
              );

              if (
                active
              ) {
                setStatus(
                  `Game server error: ${error.message}`
                );
              }
            }
          );


          socket.on(
            "disconnect",

            () => {
              if (
                active
              ) {
                setIsHost(
                  false
                );

                setStatus(
                  "Disconnected from game server..."
                );
              }
            }
          );


          socket.connect();
        } catch (
          error:
            unknown
        ) {
          console.error(
            "BuzzBoard setup error:",
            error
          );

          if (
            !active
          ) {
            return;
          }

          if (
            error instanceof
            Error
          ) {
            setStatus(
              `BuzzBoard error: ${error.message}`
            );

            return;
          }

          setStatus(
            "Unknown BuzzBoard error"
          );
        }
      }


      setupBuzzBoard();


      return () => {
        active =
          false;

        socketRef.current
          ?.disconnect();

        socketRef.current =
          null;
      };
    },

    []
  );


  /*
   * --------------------------------
   * EDITOR UPDATES
   * --------------------------------
   */

  function updateTitle(
    title:
      string
  ) {
    setEditorConfig(
      (
        current
      ) => ({
        ...current,
        title,
      })
    );

    setDirty();
  }


  function updateCategoryName(
    categoryIndex:
      number,

    name:
      string,

    round:
      1 | 2 =
      1
  ) {
    const categoryKey:
      | "categories"
      | "round2Categories" =
        round ===
          2
          ? "round2Categories"
          : "categories";

    setEditorConfig(
      (
        current
      ) => ({
        ...current,

        [categoryKey]:
          current[
            categoryKey
          ].map(
            (
              category,
              index
            ) =>
              index ===
              categoryIndex
                ? {
                    ...category,
                    name,
                  }
                : category
          ),
      })
    );

    setDirty();
  }


  function updateClue(
    categoryIndex:
      number,

    clueIndex:
      number,

    field:
      | "question"
      | "answer",

    value:
      string,

    round:
      1 | 2 =
      1
  ) {
    const categoryKey:
      | "categories"
      | "round2Categories" =
        round ===
          2
          ? "round2Categories"
          : "categories";

    setEditorConfig(
      (
        current
      ) => ({
        ...current,

        [categoryKey]:
          current[
            categoryKey
          ].map(
            (
              category,
              currentCategoryIndex
            ) => {
              if (
                currentCategoryIndex !==
                categoryIndex
              ) {
                return category;
              }

              return {
                ...category,

                clues:
                  category
                    .clues
                    .map(
                      (
                        clue,
                        currentClueIndex
                      ) =>
                        currentClueIndex ===
                        clueIndex
                          ? {
                              ...clue,

                              [field]:
                                value,
                            }
                          : clue
                    ),
              };
            }
          ),
      })
    );

    setDirty();
  }


  function toggleDailyDouble(
    categoryIndex:
      number,

    clueIndex:
      number,

    round:
      1 | 2 =
      1
  ) {
    const categoryKey:
      | "categories"
      | "round2Categories" =
        round ===
          2
          ? "round2Categories"
          : "categories";

    setEditorConfig(
      (
        current
      ) => ({
        ...current,

        [categoryKey]:
          current[
            categoryKey
          ].map(
            (
              category,
              currentCategoryIndex
            ) => {
              if (
                currentCategoryIndex !==
                categoryIndex
              ) {
                return category;
              }

              return {
                ...category,

                clues:
                  category
                    .clues
                    .map(
                      (
                        clue,
                        currentClueIndex
                      ) =>
                        currentClueIndex ===
                        clueIndex
                          ? {
                              ...clue,

                              dailyDouble:
                                !clue.dailyDouble,
                            }
                          : clue
                    ),
              };
            }
          ),
      })
    );

    setDirty();
  }


  function renderRoundEditor(
    round:
      1 | 2,

    categories:
      EditorCategory[]
  ) {
    const isRoundTwo =
      round ===
        2;

    const valueLabel =
      isRoundTwo
        ? "$200 • $400 • $600 • $800 • $1000"
        : "$100 • $200 • $300 • $400 • $500";

    return (
      <div
        className={
          isRoundTwo
            ? "round-editor-block round-editor-block-two"
            : "round-editor-block round-editor-block-one"
        }
      >
        <div className="round-editor-heading">
          <div>
            <span>
              {isRoundTwo
                ? "ROUND 2"
                : "ROUND 1"}
            </span>

            <h3>
              {isRoundTwo
                ? "Round 2"
                : "Round 1"}
            </h3>

            <p>
              {isRoundTwo
                ? "Double-value board"
                : "Opening board"}
            </p>
          </div>

          <strong>
            {valueLabel}
          </strong>
        </div>

        <div className="editor-categories">
          {categories.map(
            (
              category,
              categoryIndex
            ) => (
              <div
                className="editor-category"
                key={
                  category.id
                }
              >
                <label className="category-name-field">
                  <span>
                    Category{" "}
                    {categoryIndex +
                      1}
                  </span>

                  <input
                    type="text"
                    maxLength={
                      100
                    }
                    value={
                      category.name
                    }
                    onChange={(
                      event
                    ) =>
                      updateCategoryName(
                        categoryIndex,

                        event
                          .target
                          .value,

                        round
                      )
                    }
                  />
                </label>

                <div className="editor-clues">
                  {category
                    .clues
                    .map(
                      (
                        clue,
                        clueIndex
                      ) => (
                        <div
                          className="editor-clue"
                          key={
                            clue.id
                          }
                        >
                          <h3>
                            $
                            {
                              clue.value
                            }
                          </h3>

                          <label className="daily-double-toggle">
                            <input
                              type="checkbox"
                              checked={
                                clue.dailyDouble
                              }
                              onChange={() =>
                                toggleDailyDouble(
                                  categoryIndex,
                                  clueIndex,
                                  round
                                )
                              }
                            />

                            <span>
                              ✨ Daily Double
                            </span>
                          </label>

                          <label>
                            <span>
                              Clue
                            </span>

                            <textarea
                              rows={
                                3
                              }
                              maxLength={
                                500
                              }
                              value={
                                clue.question
                              }
                              onChange={(
                                event
                              ) =>
                                updateClue(
                                  categoryIndex,
                                  clueIndex,
                                  "question",

                                  event
                                    .target
                                    .value,

                                  round
                                )
                              }
                            />
                          </label>

                          <label>
                            <span>
                              Answer
                            </span>

                            <textarea
                              rows={
                                2
                              }
                              maxLength={
                                500
                              }
                              value={
                                clue.answer
                              }
                              onChange={(
                                event
                              ) =>
                                updateClue(
                                  categoryIndex,
                                  clueIndex,
                                  "answer",

                                  event
                                    .target
                                    .value,

                                  round
                                )
                              }
                            />
                          </label>
                        </div>
                      )
                    )}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    );
  }

  /*
   * --------------------------------
   * FINAL ROUND EDITOR
   * --------------------------------
   */

  function updateFinalRound(
    field:
      | "category"
      | "question"
      | "answer",

    value:
      string
  ) {
    setEditorConfig(
      (
        current
      ) => ({
        ...current,

        finalRound: {
          ...current
            .finalRound,

          [field]:
            value,
        },
      })
    );

    setDirty();
  }


  /*
   * --------------------------------
   * GAME LIBRARY
   * --------------------------------
   */

  function createNewGame() {
    setEditorConfig(
      createBlankGameConfig()
    );

    awaitingLibrarySyncRef
      .current =
      false;

    setDirty(
      "New game, not saved yet"
    );

    setLibraryMessage(
      "New game created."
    );
  }


  function saveToLibrary() {
    awaitingLibrarySyncRef
      .current =
      true;

    setLibraryMessage(
      "Saving game..."
    );

    socketRef.current
      ?.emit(
        "save_game_to_library",

        editorConfig
      );
  }


  function loadSavedGame(
    id:
      string
  ) {
    awaitingLibrarySyncRef
      .current =
      true;

    setLibraryMessage(
      "Loading game..."
    );

    socketRef.current
      ?.emit(
        "load_saved_game",

        id
      );
  }


  function deleteSavedGame(
    game:
      SavedGameSummary
  ) {
    setLibraryMessage(
      `Deleting "${game.title}"...`
    );

    socketRef.current
      ?.emit(
        "delete_saved_game",

        game.id
      );
  }


  /*
   * SECTION 4 CONTINUES HERE
   */

  /*
   * --------------------------------
   * NORMAL GAME EVENTS
   * --------------------------------
   */

  function startGame() {
    socketRef.current
      ?.emit(
        "start_game"
      );
  }


  function startRoundTwo() {
    socketRef.current
      ?.emit(
        "start_round_2"
      );
  }


  function selectClue(
    categoryId:
      string,

    clueId:
      string
  ) {
    socketRef.current
      ?.emit(
        "select_clue",

        {
          categoryId,
          clueId,
        }
      );
  }


  /*
   * --------------------------------
   * DAILY DOUBLE EVENTS
   * --------------------------------
   */

  function selectDailyDoublePlayer(
    playerId:
      string
  ) {
    socketRef.current
      ?.emit(
        "select_daily_double_player",

        playerId
      );
  }


  function submitDailyDoubleWager() {
    const wager =
      Number(
        dailyDoubleWagerInput
      );

    if (
      !Number.isFinite(
        wager
      )
    ) {
      return;
    }

    socketRef.current
      ?.emit(
        "submit_daily_double_wager",

        wager
      );
  }


  function judgeDailyDoubleCorrect() {
    socketRef.current
      ?.emit(
        "judge_daily_double_correct"
      );
  }


  function judgeDailyDoubleIncorrect() {
    socketRef.current
      ?.emit(
        "judge_daily_double_incorrect"
      );
  }


  /*
   * --------------------------------
   * BUZZER EVENTS
   * --------------------------------
   */

  function openBuzzer() {
    socketRef.current
      ?.emit(
        "open_buzzer"
      );
  }


  function buzz() {
    socketRef.current
      ?.emit(
        "buzz"
      );
  }


  function judgeCorrect() {
    socketRef.current
      ?.emit(
        "judge_correct"
      );
  }


  function judgeIncorrect() {
    socketRef.current
      ?.emit(
        "judge_incorrect"
      );
  }


  function noCorrectAnswer() {
    socketRef.current
      ?.emit(
        "no_correct_answer"
      );
  }


  /*
   * --------------------------------
   * HOST TOOLS
   * --------------------------------
   */

  function adjustHostScore(
    direction:
      1 | -1
  ) {
    const rawAmount =
      Number(
        hostScoreAmount
      );

    if (
      !Number.isFinite(
        rawAmount
      )
    ) {
      return;
    }

    const amount =
      Math.abs(
        Math.trunc(
          rawAmount
        )
      );

    if (
      !hostSelectedPlayerId ||
      amount <=
        0
    ) {
      return;
    }

    socketRef.current
      ?.emit(
        "adjust_score",

        {
          playerId:
            hostSelectedPlayerId,

          amount:
            amount *
            direction,
        }
      );
  }


  function reopenBuzzers() {
    socketRef.current
      ?.emit(
        "reopen_buzzers"
      );
  }


  function skipClue() {
    socketRef.current
      ?.emit(
        "skip_clue"
      );
  }


  function undoLastAction() {
    socketRef.current
      ?.emit(
        "undo_last_action"
      );
  }


  /*
   * --------------------------------
   * FINAL ROUND EVENTS
   * --------------------------------
   */

  function submitFinalWager() {
    const wager =
      Number(
        finalWagerInput
      );

    if (
      !Number.isFinite(
        wager
      )
    ) {
      return;
    }

    socketRef.current
      ?.emit(
        "submit_final_wager",

        wager
      );
  }


  function revealFinalClue() {
    socketRef.current
      ?.emit(
        "reveal_final_clue"
      );
  }


  function submitFinalAnswer() {
    socketRef.current
      ?.emit(
        "submit_final_answer",

        finalAnswerInput
      );
  }


  function revealFinalAnswers() {
    socketRef.current
      ?.emit(
        "reveal_final_answers"
      );
  }


  function judgeFinalAnswer(
    playerId:
      string,

    correct:
      boolean
  ) {
    socketRef.current
      ?.emit(
        "judge_final_answer",

        {
          playerId,
          correct,
        }
      );
  }


  function returnToLobby() {
    socketRef.current
      ?.emit(
        "return_to_lobby"
      );
  }


  /*
   * --------------------------------
   * DERIVED STATE
   * --------------------------------
   */

  const currentPlayer =
    gameState.players
      .find(
        (
          player
        ) =>
          player.id ===
          currentUserId
      );


  const maxFinalWager =
    Math.max(
      0,

      Math.floor(
        currentPlayer
          ?.score ??
        0
      )
    );


  const dailyDoublePlayer =
    gameState.players
      .find(
        (
          player
        ) =>
          player.id ===
          gameState.dailyDouble
            .playerId
      );


  const isDailyDoublePlayer =
    currentUserId !==
      null &&
    gameState.dailyDouble
      .playerId ===
      currentUserId;


  const lockedOut =
    currentUserId !==
      null &&
    gameState.buzzer
      .lockedOut
      .includes(
        currentUserId
      );


  const eligiblePlayers =
    gameState.players
      .filter(
        (
          player
        ) =>
          !gameState
            .buzzer
            .lockedOut
            .includes(
              player.id
            )
      );


  /*
   * --------------------------------
   * COUNTDOWN VALUES
   * --------------------------------
   */

  const buzzerCountdown =
    formatCountdown(
      gameState
        .timers
        .buzzerEndsAt,

      clockNow
    );


  const answerCountdown =
    formatCountdown(
      gameState
        .timers
        .answerEndsAt,

      clockNow
    );


  const buzzerCountdownNumber =
    buzzerCountdown ===
      null
      ? null
      : Number(
          buzzerCountdown
        );


  const answerCountdownNumber =
    answerCountdown ===
      null
      ? null
      : Number(
          answerCountdown
        );


  const buzzerTimerUrgent =
    buzzerCountdownNumber !==
      null &&
    buzzerCountdownNumber >
      0 &&
    buzzerCountdownNumber <=
      3;


  const answerTimerUrgent =
    answerCountdownNumber !==
      null &&
    answerCountdownNumber >
      0 &&
    answerCountdownNumber <=
      3;


  const answerTimerPlayer =
    gameState.players
      .find(
        (
          player
        ) =>
          player.id ===
          gameState
            .timers
            .answerPlayerId
      );


  const currentUserIsAnswering =
    currentUserId !==
      null &&
    gameState
      .timers
      .answerPlayerId ===
      currentUserId;


  /*
   * --------------------------------
   * SOUND TOGGLE
   * --------------------------------
   */

  const soundToggle = (
    <button
      type="button"
      className={
        soundEnabled
          ? "sound-toggle-button"
          : "sound-toggle-button sound-toggle-muted"
      }
      onClick={
        toggleSound
      }
      aria-pressed={
        soundEnabled
      }
      title={
        soundEnabled
          ? "Mute BuzzBoard sounds"
          : "Turn on BuzzBoard sounds"
      }
    >
      <span>
        {soundEnabled
          ? "🔊"
          : "🔇"}
      </span>

      <strong>
        {soundEnabled
          ? "Sound"
          : "Muted"}
      </strong>
    </button>
  );


  /*
   * --------------------------------
   * TIMER UI
   * --------------------------------
   */

  const buzzerTimer =
    buzzerCountdown !==
      null ? (
      <div
        className={
          buzzerTimerUrgent
            ? "timer-card buzzer-timer-card timer-card-urgent"
            : "timer-card buzzer-timer-card"
        }
      >
        <span>
          BUZZ WINDOW
        </span>

        <strong>
          {buzzerCountdown}
        </strong>

        <small>
          seconds
        </small>
      </div>
    ) :
      null;


  const answerTimer =
    answerCountdown !==
      null ? (
      <div
        className={
          answerTimerUrgent
            ? "timer-card answer-timer-card timer-card-urgent"
            : "timer-card answer-timer-card"
        }
      >
        <span>
          ANSWER TIME
        </span>

        <strong>
          {answerCountdown}
        </strong>

        <small>
          seconds
        </small>
      </div>
    ) :
      null;


  /*
   * --------------------------------
   * HOST TOOL AVAILABILITY
   * --------------------------------
   */

  const canReopenBuzzers =
    gameState.phase ===
      "clue" &&
    gameState.currentClue !==
      null &&
    eligiblePlayers.length >
      0;


  const canSkipClue =
    gameState.currentClue !==
      null &&
    [
      "clue",
      "daily_double_select",
      "daily_double_wager",
      "daily_double_clue",
    ].includes(
      gameState.phase
    );


  /*
   * --------------------------------
   * HOST TOOLS PANEL
   * --------------------------------
   */

  const hostToolsPanel =
    isHost &&
    gameState.phase !==
      "lobby" ? (
      <section className="host-tools-panel">
        <div className="host-tools-heading">
          <div>
            <span>
              🛠 HOST TOOLS
            </span>

            <h2>
              Game Controls
            </h2>
          </div>

          <small>
            Host only
          </small>
        </div>


        <div className="host-score-tools">
          <label>
            <span>
              Player
            </span>

            <select
              value={
                hostSelectedPlayerId
              }
              onChange={(
                event
              ) =>
                setHostSelectedPlayerId(
                  event
                    .target
                    .value
                )
              }
            >
              {gameState.players.map(
                (
                  player
                ) => (
                  <option
                    key={
                      player.id
                    }
                    value={
                      player.id
                    }
                  >
                    {player.name} (
                    {formatScore(
                      player.score
                    )}
                    )
                  </option>
                )
              )}
            </select>
          </label>


          <label>
            <span>
              Amount
            </span>

            <input
              type="number"
              min={1}
              max={100000}
              step={1}
              value={
                hostScoreAmount
              }
              onChange={(
                event
              ) =>
                setHostScoreAmount(
                  event
                    .target
                    .value
                )
              }
            />
          </label>
        </div>


        <div className="host-score-buttons">
          <button
            type="button"
            className="host-add-score-button"
            onClick={() =>
              adjustHostScore(
                1
              )
            }
            disabled={
              !hostSelectedPlayerId
            }
          >
            + Add
          </button>

          <button
            type="button"
            className="host-subtract-score-button"
            onClick={() =>
              adjustHostScore(
                -1
              )
            }
            disabled={
              !hostSelectedPlayerId
            }
          >
            − Subtract
          </button>
        </div>


        <div className="host-utility-buttons">
          <button
            type="button"
            onClick={
              reopenBuzzers
            }
            disabled={
              !canReopenBuzzers
            }
          >
            🔓 Reopen Buzzers
          </button>

          <button
            type="button"
            onClick={
              skipClue
            }
            disabled={
              !canSkipClue
            }
          >
            ⏭ Skip / End Clue
          </button>

          <button
            type="button"
            className="host-undo-button"
            onClick={
              undoLastAction
            }
            disabled={
              !gameState
                .hostTools
                .canUndo
            }
            title={
              gameState
                .hostTools
                .undoLabel
                ? `Undo: ${
                    gameState
                      .hostTools
                      .undoLabel
                  }`
                : "Nothing to undo"
            }
          >
            ↶ Undo Last Action
          </button>
        </div>

        {gameState
          .hostTools
          .canUndo &&
          gameState
            .hostTools
            .undoLabel && (
            <p className="host-undo-label">
              Undo available:{" "}
              <strong>
                {
                  gameState
                    .hostTools
                    .undoLabel
                }
              </strong>
            </p>
          )}
      </section>
    ) :
      null;


  /*
   * --------------------------------
   * SCOREBOARD
   * --------------------------------
   */

  const scoreboard = (
    <div className="scoreboard">
      {gameState.players.map(
        (
          player
        ) => (
          <div
            className="score-card"
            key={
              player.id
            }
          >
            <span className="score-name">
              {
                player.name
              }

              {player.id ===
                gameState.hostId &&
                " 👑"}
            </span>

            <strong>
              {formatScore(
                player.score
              )}
            </strong>
          </div>
        )
      )}
    </div>
  );


  /*
   * SECTION 5 CONTINUES HERE
   */

  /*
   * ================================================
   * DAILY DOUBLE - CHOOSE CONTESTANT
   * ================================================
   */

  if (
    gameState.phase ===
      "daily_double_select" &&
    gameState.currentClue
  ) {
    const clue =
      gameState.currentClue;

    return (
      <main className="game">
        <h1>
          Daily Double!
        </h1>

        <p>
          {
            clue.categoryName
          }{" "}
          • $
          {
            clue.value
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section
          className={
            feedback
              ?.kind ===
              "daily_double"
              ? "daily-double-screen feedback-pop-card"
              : "daily-double-screen"
          }
        >
          <div className="daily-double-label">
            ✨ DAILY DOUBLE ✨
          </div>

          <h2>
            Choose the Contestant
          </h2>

          {isHost ? (
            <>
              <p>
                Select the player who
                controls this Daily
                Double. Only that player
                will wager and answer.
              </p>

              <div className="daily-double-player-grid">
                {gameState.players.map(
                  (
                    player
                  ) => (
                    <button
                      type="button"
                      className="daily-double-player-button"
                      key={
                        player.id
                      }
                      onClick={() =>
                        selectDailyDoublePlayer(
                          player.id
                        )
                      }
                    >
                      <span>
                        {player.name}
                      </span>

                      <strong>
                        {formatScore(
                          player.score
                        )}
                      </strong>
                    </button>
                  )
                )}
              </div>
            </>
          ) : (
            <p className="daily-double-waiting">
              The host is choosing
              who will play this
              Daily Double...
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * DAILY DOUBLE - WAGER
   * ================================================
   */

  if (
    gameState.phase ===
      "daily_double_wager" &&
    gameState.currentClue
  ) {
    const clue =
      gameState.currentClue;

    return (
      <main className="game">
        <h1>
          Daily Double!
        </h1>

        <p>
          {
            clue.categoryName
          }{" "}
          • $
          {
            clue.value
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section className="daily-double-screen">
          <div className="daily-double-label">
            ✨ DAILY DOUBLE ✨
          </div>

          <h2>
            {dailyDoublePlayer
              ?.name ??
              "Contestant"}
          </h2>

          {isDailyDoublePlayer ? (
            <>
              <p>
                You may wager up to{" "}
                <strong>
                  {formatScore(
                    gameState
                      .dailyDouble
                      .maxWager
                  )}
                </strong>
                .
              </p>

              <div className="daily-double-wager-area">
                <label>
                  <span>
                    Your Wager
                  </span>

                  <input
                    type="number"
                    min={0}
                    max={
                      gameState
                        .dailyDouble
                        .maxWager
                    }
                    step={1}
                    value={
                      dailyDoubleWagerInput
                    }
                    onChange={(
                      event
                    ) =>
                      setDailyDoubleWagerInput(
                        event
                          .target
                          .value
                      )
                    }
                  />
                </label>

                <button
                  type="button"
                  onClick={
                    submitDailyDoubleWager
                  }
                  disabled={
                    dailyDoubleWagerInput
                      .trim() ===
                    ""
                  }
                >
                  Lock Wager
                </button>
              </div>
            </>
          ) : (
            <p className="daily-double-waiting">
              Waiting for{" "}
              <strong>
                {dailyDoublePlayer
                  ?.name ??
                  "the contestant"}
              </strong>{" "}
              to lock a wager...
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * DAILY DOUBLE - CLUE
   * ================================================
   */

  if (
    gameState.phase ===
      "daily_double_clue" &&
    gameState.currentClue
  ) {
    const clue =
      gameState.currentClue;

    return (
      <main className="game">
        <h1>
          Daily Double!
        </h1>

        <p>
          {
            clue.categoryName
          }{" "}
          • Wager{" "}
          {formatScore(
            gameState
              .dailyDouble
              .wager ??
            0
          )}
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section className="daily-double-screen daily-double-clue-screen">
          <div className="daily-double-label">
            ✨ DAILY DOUBLE ✨
          </div>

          <p className="daily-double-contestant">
            Playing:{" "}
            <strong>
              {dailyDoublePlayer
                ?.name ??
                "Contestant"}
            </strong>
          </p>

          <h2 className="daily-double-question">
            {clue.question ||
              "(No clue text entered)"}
          </h2>

          {answerTimer}

          {isHost &&
            clue.answer !==
              null && (
              <div className="host-answer">
                <span>
                  HOST ANSWER
                </span>

                <strong>
                  {clue.answer ||
                    "(No answer entered)"}
                </strong>
              </div>
            )}

          {isDailyDoublePlayer ? (
            <p className="daily-double-your-turn">
              🎯 This is your Daily
              Double. Answer aloud in
              Discord.
            </p>
          ) : (
            <p className="daily-double-waiting">
              Waiting for{" "}
              <strong>
                {dailyDoublePlayer
                  ?.name ??
                  "the contestant"}
              </strong>{" "}
              to answer...
            </p>
          )}

          {isHost && (
            <div className="judge-controls">
              <button
                type="button"
                className="correct-button"
                onClick={
                  judgeDailyDoubleCorrect
                }
              >
                ✓ Correct
              </button>

              <button
                type="button"
                className="incorrect-button"
                onClick={
                  judgeDailyDoubleIncorrect
                }
              >
                ✕ Incorrect
              </button>
            </div>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * FINAL ROUND - WAGER
   * ================================================
   */

  if (
    gameState.phase ===
      "final_wager" &&
    gameState.finalRound
  ) {
    const finalRound =
      gameState.finalRound;

    return (
      <main className="game">
        <h1>
          Final Round
        </h1>

        <p>
          {
            finalRound.category
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section
          className={
            feedback
              ?.kind ===
              "final"
              ? "final-round-screen feedback-pop-card"
              : "final-round-screen"
          }
        >
          <div className="final-round-label">
            FINAL ROUND
          </div>

          <h2>
            Place Your Wager
          </h2>

          <p>
            Your current score is{" "}
            <strong>
              {formatScore(
                currentPlayer
                  ?.score ??
                0
              )}
            </strong>
            .
          </p>

          <p>
            You may wager up to{" "}
            <strong>
              {formatScore(
                maxFinalWager
              )}
            </strong>
            .
          </p>

          {finalRound
            .ownWagerLocked ? (
            <div className="final-locked-card">
              <span>
                🔒 Wager Locked
              </span>

              <strong>
                {formatScore(
                  finalRound
                    .ownWager ??
                  0
                )}
              </strong>
            </div>
          ) : (
            <div className="final-input-area">
              <label>
                <span>
                  Your Wager
                </span>

                <input
                  type="number"
                  min={0}
                  max={
                    maxFinalWager
                  }
                  step={1}
                  value={
                    finalWagerInput
                  }
                  onChange={(
                    event
                  ) =>
                    setFinalWagerInput(
                      event
                        .target
                        .value
                    )
                  }
                />
              </label>

              <button
                type="button"
                onClick={
                  submitFinalWager
                }
                disabled={
                  finalWagerInput
                    .trim() ===
                  ""
                }
              >
                Lock Wager
              </button>
            </div>
          )}

          <div className="final-status-list">
            {finalRound
              .statuses
              .map(
                (
                  player
                ) => (
                  <div
                    className="final-status-row"
                    key={
                      player.playerId
                    }
                  >
                    <span>
                      {
                        player.name
                      }
                    </span>

                    <strong>
                      {player
                        .wagerLocked
                        ? "✓ Wager Locked"
                        : "Choosing Wager..."}
                    </strong>
                  </div>
                )
              )}
          </div>

          {isHost &&
            finalRound
              .allWagersLocked && (
              <button
                type="button"
                className="final-primary-button"
                onClick={
                  revealFinalClue
                }
              >
                Reveal Final Clue
              </button>
            )}

          {isHost &&
            !finalRound
              .allWagersLocked && (
              <p className="final-waiting">
                Waiting for every
                player to lock their
                wager...
              </p>
            )}

          {!isHost && (
            <p className="final-waiting">
              {finalRound
                .allWagersLocked
                ? "Waiting for the host to reveal the clue..."
                : "Waiting for all wagers..."}
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * FINAL ROUND - CLUE
   * ================================================
   */

  if (
    gameState.phase ===
      "final_clue" &&
    gameState.finalRound
  ) {
    const finalRound =
      gameState.finalRound;

    return (
      <main className="game">
        <h1>
          Final Round
        </h1>

        <p>
          {
            finalRound.category
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section className="final-round-screen">
          <div className="final-round-label">
            FINAL CLUE
          </div>

          <h2 className="final-question">
            {finalRound
              .question ||
              "(No Final clue entered)"}
          </h2>

          {finalRound
            .ownAnswerLocked ? (
            <div className="final-locked-card">
              <span>
                🔒 Answer Locked
              </span>

              <strong>
                {finalRound
                  .ownAnswer ||
                  "(Blank Answer)"}
              </strong>
            </div>
          ) : (
            <div className="final-input-area">
              <label>
                <span>
                  Your Final Answer
                </span>

                <textarea
                  rows={4}
                  maxLength={
                    500
                  }
                  value={
                    finalAnswerInput
                  }
                  onChange={(
                    event
                  ) =>
                    setFinalAnswerInput(
                      event
                        .target
                        .value
                    )
                  }
                  placeholder="Type your answer privately..."
                />
              </label>

              <button
                type="button"
                onClick={
                  submitFinalAnswer
                }
              >
                Lock Answer
              </button>
            </div>
          )}

          <div className="final-status-list">
            {finalRound
              .statuses
              .map(
                (
                  player
                ) => (
                  <div
                    className="final-status-row"
                    key={
                      player.playerId
                    }
                  >
                    <span>
                      {
                        player.name
                      }
                    </span>

                    <strong>
                      {player
                        .answerLocked
                        ? "✓ Answer Locked"
                        : "Writing Answer..."}
                    </strong>
                  </div>
                )
              )}
          </div>

          {isHost &&
            finalRound
              .allAnswersLocked && (
              <button
                type="button"
                className="final-primary-button"
                onClick={
                  revealFinalAnswers
                }
              >
                Reveal Answers
              </button>
            )}

          {isHost &&
            !finalRound
              .allAnswersLocked && (
              <p className="final-waiting">
                Waiting for every
                player to lock their
                answer...
              </p>
            )}

          {!isHost && (
            <p className="final-waiting">
              {finalRound
                .allAnswersLocked
                ? "Waiting for the host to reveal everyone's answers..."
                : "Waiting for all answers..."}
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * FINAL ROUND - ANSWER REVEAL
   * ================================================
   */

  if (
    gameState.phase ===
      "final_reveal" &&
    gameState.finalRound
  ) {
    const finalRound =
      gameState.finalRound;

    return (
      <main className="game">
        <h1>
          Final Round
        </h1>

        <p>
          {
            finalRound.category
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section className="final-round-screen final-reveal-screen">
          <div className="final-round-label">
            ANSWERS REVEALED
          </div>

          <h2 className="final-question">
            {finalRound
              .question ||
              "(No Final clue entered)"}
          </h2>

          {isHost &&
            finalRound
              .correctAnswer !==
              null && (
              <div className="host-answer">
                <span>
                  CORRECT ANSWER
                </span>

                <strong>
                  {finalRound
                    .correctAnswer ||
                    "(No answer entered)"}
                </strong>
              </div>
            )}

          <div className="final-reveal-list">
            {finalRound
              .statuses
              .map(
                (
                  player
                ) => (
                  <article
                    className="final-reveal-card"
                    key={
                      player.playerId
                    }
                  >
                    <h3>
                      {
                        player.name
                      }
                    </h3>

                    <div className="final-reveal-detail">
                      <span>
                        Answer
                      </span>

                      <strong>
                        {player
                          .answer ||
                          "(Blank Answer)"}
                      </strong>
                    </div>

                    <div className="final-reveal-detail">
                      <span>
                        Wager
                      </span>

                      <strong>
                        {formatScore(
                          player
                            .wager ??
                          0
                        )}
                      </strong>
                    </div>

                    {player
                      .judged ===
                      true && (
                      <div className="final-judged-correct">
                        ✓ Correct
                      </div>
                    )}

                    {player
                      .judged ===
                      false && (
                      <div className="final-judged-incorrect">
                        ✕ Incorrect
                      </div>
                    )}

                    {player
                      .judged ===
                      null &&
                      isHost && (
                        <div className="judge-controls">
                          <button
                            type="button"
                            className="correct-button"
                            onClick={() =>
                              judgeFinalAnswer(
                                player.playerId,
                                true
                              )
                            }
                          >
                            ✓ Correct
                          </button>

                          <button
                            type="button"
                            className="incorrect-button"
                            onClick={() =>
                              judgeFinalAnswer(
                                player.playerId,
                                false
                              )
                            }
                          >
                            ✕ Incorrect
                          </button>
                        </div>
                      )}

                    {player
                      .judged ===
                      null &&
                      !isHost && (
                        <p className="final-waiting">
                          Waiting for
                          host ruling...
                        </p>
                      )}
                  </article>
                )
              )}
          </div>
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * FINISHED GAME
   * ================================================
   */

  if (
    gameState.phase ===
      "finished"
  ) {
    const rankedPlayers =
      [
        ...gameState.players,
      ].sort(
        (
          a,
          b
        ) =>
          b.score -
          a.score
      );

    const topScore =
      rankedPlayers.length >
      0
        ? rankedPlayers[0]
            .score
        : 0;

    const winners =
      rankedPlayers.filter(
        (
          player
        ) =>
          player.score ===
          topScore
      );

    const isTie =
      winners.length >
      1;

    return (
      <main className="game">
        <h1>
          BuzzBoard
        </h1>

        <p>
          Game Complete!
        </p>

        {soundToggle}

        {hostToolsPanel}

        <section
          className={
            feedback
              ?.kind ===
              "complete"
              ? "final-results feedback-pop-card"
              : "final-results"
          }
        >
          <div className="final-heading">
            <span>
              🏁 GAME COMPLETE
            </span>

            <h2>
              Final Scores
            </h2>
          </div>

          <div className="winner-banner">
            {isTie ? (
              <>
                <span>
                  🏆 TIE GAME 🏆
                </span>

                <strong>
                  {winners
                    .map(
                      (
                        player
                      ) =>
                        player.name
                    )
                    .join(
                      " & "
                    )}
                </strong>

                <small>
                  {formatScore(
                    topScore
                  )}{" "}
                  each
                </small>
              </>
            ) : winners.length >
              0 ? (
              <>
                <span>
                  🏆 WINNER
                </span>

                <strong>
                  {
                    winners[0]
                      .name
                  }
                </strong>

                <small>
                  {formatScore(
                    winners[0]
                      .score
                  )}
                </small>
              </>
            ) : (
              <strong>
                Game Complete
              </strong>
            )}
          </div>

          <div className="final-score-list">
            {rankedPlayers.map(
              (
                player,
                index
              ) => (
                <div
                  className={
                    winners.some(
                      (
                        winner
                      ) =>
                        winner.id ===
                        player.id
                    )
                      ? "final-player final-player-winner"
                      : "final-player"
                  }
                  key={
                    player.id
                  }
                >
                  <span className="final-place">
                    {index ===
                    0
                      ? "🥇"
                      : index ===
                          1
                        ? "🥈"
                        : index ===
                            2
                          ? "🥉"
                          : `#${index + 1}`}
                  </span>

                  <span className="final-player-name">
                    {
                      player.name
                    }
                  </span>

                  <strong>
                    {formatScore(
                      player.score
                    )}
                  </strong>
                </div>
              )
            )}
          </div>

          {isHost ? (
            <button
              type="button"
              className="return-lobby-button"
              onClick={
                returnToLobby
              }
            >
              Return to Lobby
            </button>
          ) : (
            <p className="final-waiting">
              Waiting for the host
              to return to the
              lobby...
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * ROUND BREAK
   * ================================================
   */

  if (
    gameState.phase ===
      "round_break"
  ) {
    return (
      <main className="game round-break-page">
        <h1>
          Round 1 Complete!
        </h1>

        <p>
          Scores carry forward into
          Round 2.
        </p>

        {scoreboard}

        <section className="round-break-screen">
          <div className="round-break-label">
            ✨ ROUND 1 COMPLETE ✨
          </div>

          <h2>
            Round 2 is Ready
          </h2>

          <p>
            The board resets, but every
            player's score stays exactly
            where it is.
          </p>

          <div className="round-break-values">
            <span>
              ROUND 2 CLUE VALUES
            </span>

            <strong>
              $200 • $400 • $600 • $800 • $1000
            </strong>
          </div>

          {isHost ? (
            <button
              type="button"
              className="round-two-start-button"
              onClick={
                startRoundTwo
              }
            >
              Start Round 2
            </button>
          ) : (
            <p className="round-break-waiting">
              Waiting for the host to
              start Round 2...
            </p>
          )}
        </section>
      </main>
    );
  }


  /*
   * ================================================
   * NORMAL CLUE
   * ================================================
   */

  if (
    gameState.phase ===
      "clue" &&
    gameState.currentClue
  ) {
    const clue =
      gameState.currentClue;

    const winner =
      gameState.buzzer
        .winner;

    return (
      <main className="game">
        <h1>
          BuzzBoard
        </h1>

        <p>
          {
            clue.categoryName
          }{" "}
          • $
          {
            clue.value
          }
        </p>

        {soundToggle}

        {scoreboard}

        {hostToolsPanel}

        <section className="clue-screen">
          <h2>
            {clue.question ||
              "(No clue text entered)"}
          </h2>

          {isHost &&
            clue.answer !==
              null && (
              <div className="host-answer">
                <span>
                  HOST ANSWER
                </span>

                <strong>
                  {clue.answer ||
                    "(No answer entered)"}
                </strong>
              </div>
            )}

          {gameState
            .buzzer
            .lockedOut
            .length >
            0 && (
            <p className="lockout-list">
              Locked out:{" "}
              {gameState.players
                .filter(
                  (
                    player
                  ) =>
                    gameState
                      .buzzer
                      .lockedOut
                      .includes(
                        player.id
                      )
                )
                .map(
                  (
                    player
                  ) =>
                    player.name
                )
                .join(
                  ", "
                )}
            </p>
          )}

          {!gameState
            .buzzer
            .open &&
            !winner &&
            isHost &&
            eligiblePlayers
              .length >
              0 && (
              <button
                type="button"
                onClick={
                  openBuzzer
                }
              >
                Open Buzzers
              </button>
            )}

          {!gameState
            .buzzer
            .open &&
            !winner &&
            !isHost &&
            !lockedOut && (
              <p>
                Waiting for the
                host to open the
                buzzers...
              </p>
            )}

          {lockedOut &&
            !winner && (
              <p className="locked-message">
                ❌ You are locked
                out for this clue.
              </p>
            )}

          {gameState
            .buzzer
            .open && (
            <>
              <p className="buzzer-status">
                🔴 BUZZERS OPEN
              </p>

              {buzzerTimer}

              {lockedOut ? (
                <button
                  type="button"
                  className="buzz-button"
                  disabled
                >
                  LOCKED OUT
                </button>
              ) : (
                <button
                  type="button"
                  className="buzz-button"
                  onClick={
                    buzz
                  }
                >
                  BUZZ!
                </button>
              )}
            </>
          )}

          {winner && (
            <div
              className={
                feedback
                  ?.kind ===
                  "buzz"
                  ? "winner winner-pop"
                  : "winner"
              }
            >
              <h2>
                🔔{" "}
                {
                  winner.name
                }
              </h2>

              <p>
                Buzzed first!
              </p>

              {answerTimer}

              {answerTimerPlayer && (
                <p className="answering-player">
                  {currentUserIsAnswering
                    ? "🎤 Your turn to answer!"
                    : `🎤 ${answerTimerPlayer.name} is answering...`}
                </p>
              )}

              {isHost && (
                <div className="judge-controls">
                  <button
                    type="button"
                    className="correct-button"
                    onClick={
                      judgeCorrect
                    }
                  >
                    ✓ Correct
                  </button>

                  <button
                    type="button"
                    className="incorrect-button"
                    onClick={
                      judgeIncorrect
                    }
                  >
                    ✕ Incorrect
                  </button>
                </div>
              )}

              {!isHost && (
                <p>
                  Waiting for the
                  host's ruling...
                </p>
              )}
            </div>
          )}

          {isHost &&
            !winner && (
              <button
                type="button"
                className="secondary-button"
                onClick={
                  noCorrectAnswer
                }
              >
                No Correct Answer
              </button>
            )}
        </section>
      </main>
    );
  }


  /*
   * SECTION 6 CONTINUES HERE
   */

  /*
   * ================================================
   * NORMAL BOARD
   * ================================================
   */

  if (
    gameState.phase ===
      "board" &&
    gameState.board
  ) {
    return (
      <main className="game">
        <h1>
          {
            gameState.board
              .title
          }
        </h1>

        <div
          className={
            gameState.currentRound ===
              2
              ? "round-board-banner round-board-banner-two"
              : "round-board-banner round-board-banner-one"
          }
        >
          <span>
            ROUND{" "}
            {
              gameState
                .currentRound
            }
          </span>

          <strong>
            {gameState
              .currentRound ===
            2
              ? "$200 • $400 • $600 • $800 • $1000"
              : "$100 • $200 • $300 • $400 • $500"}
          </strong>
        </div>

        {scoreboard}

        {hostToolsPanel}

        {isHost ? (
          <p>
            👑 Host controls enabled
          </p>
        ) : (
          <p>
            Waiting for the host
            to choose a clue...
          </p>
        )}

        <div className="board">
          {gameState.board
            .categories
            .map(
              (
                category
              ) => (
                <div
                  className="category"
                  key={
                    category.id
                  }
                >
                  <h2>
                    {
                      category.name
                    }
                  </h2>

                  {category
                    .clues
                    .map(
                      (
                        clue
                      ) => {
                        const used =
                          gameState
                            .usedClues
                            .includes(
                              clue.id
                            );

                        return (
                          <button
                            className={
                              used
                                ? "clue used-clue"
                                : "clue"
                            }
                            key={
                              clue.id
                            }
                            type="button"
                            disabled={
                              !isHost ||
                              used
                            }
                            onClick={() =>
                              selectClue(
                                category.id,
                                clue.id
                              )
                            }
                          >
                            {used
                              ? "USED"
                              : `$${clue.value}`}
                          </button>
                        );
                      }
                    )}
                </div>
              )
            )}
        </div>
      </main>
    );
  }


  /*
   * ================================================
   * LOBBY + LIBRARY + EDITOR
   * ================================================
   */

  return (
    <main className="game">
      <h1>
        BuzzBoard
      </h1>

      <p>
        Discord Game Show
      </p>

      {soundToggle}


      <section className="lobby-panel">
        <h2>
          Game Lobby
        </h2>

        <p>
          {status}
        </p>

        <div className="players">
          <h3>
            Players (
            {
              gameState
                .players
                .length
            }
            )
          </h3>

          {gameState.players
            .length ===
          0 ? (
            <p>
              Waiting for
              players...
            </p>
          ) : (
            <ul>
              {gameState.players
                .map(
                  (
                    player
                  ) => (
                    <li
                      key={
                        player.id
                      }
                    >
                      🟢{" "}
                      {
                        player.name
                      }

                      {player.id ===
                        gameState
                          .hostId && (
                        <strong>
                          {" "}
                          👑 HOST
                        </strong>
                      )}
                    </li>
                  )
                )}
            </ul>
          )}
        </div>

        {!isHost &&
          gameState.board && (
            <div className="waiting-game">
              <strong>
                Game Ready
              </strong>

              <span>
                {
                  gameState
                    .board
                    .title
                }
              </span>
            </div>
          )}

        {!isHost && (
          <button
            type="button"
            disabled
          >
            Waiting for Host
          </button>
        )}
      </section>


      {isHost && (
        <>
          {/*
           * -----------------------------
           * GAME LIBRARY
           * -----------------------------
           */}

          <section className="game-library">
            <div className="library-heading">
              <div>
                <h2>
                  Your Games
                </h2>

                <p>
                  Saved games survive
                  server and computer
                  restarts.
                </p>
              </div>

              <button
                type="button"
                onClick={
                  createNewGame
                }
              >
                + Create New
              </button>
            </div>

            {libraryMessage && (
              <p className="library-message">
                {
                  libraryMessage
                }
              </p>
            )}

            {savedGames
              .length ===
            0 ? (
              <div className="empty-library">
                <strong>
                  No saved games
                  yet
                </strong>

                <span>
                  Create a game
                  below, then save
                  it to your
                  library.
                </span>
              </div>
            ) : (
              <div className="library-grid">
                {savedGames.map(
                  (
                    game
                  ) => (
                    <article
                      className="library-card"
                      key={
                        game.id
                      }
                    >
                      <div>
                        <h3>
                          {
                            game.title
                          }
                        </h3>

                        <p>
                          {
                            game.categoryCount
                          }{" "}
                          categories •{" "}
                          {
                            game.clueCount
                          }{" "}
                          clues
                        </p>

                        <small>
                          {formatSavedDate(
                            game.updatedAt
                          )}
                        </small>
                      </div>

                      <div className="library-card-actions">
                        <button
                          type="button"
                          onClick={() =>
                            loadSavedGame(
                              game.id
                            )
                          }
                        >
                          Load
                        </button>

                        <button
                          type="button"
                          className="delete-game-button"
                          onClick={() =>
                            deleteSavedGame(
                              game
                            )
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  )
                )}
              </div>
            )}
          </section>


          {/*
           * -----------------------------
           * GAME EDITOR
           * -----------------------------
           */}

          <section className="editor">
            <div className="editor-heading">
              <div>
                <h2>
                  Game Editor
                </h2>

                <p>
                  Build Round 1 and
                  Round 2 with six
                  categories and five
                  clues each, plus
                  one Final Round.
                </p>
              </div>

              <span className="editor-status">
                {editorDirty
                  ? "Unsaved changes"
                  : editorMessage ||
                    "Ready"}
              </span>
            </div>


            <label className="editor-title">
              <span>
                Game Title
              </span>

              <input
                type="text"
                maxLength={
                  100
                }
                value={
                  editorConfig
                    .title
                }
                onChange={(
                  event
                ) =>
                  updateTitle(
                    event
                      .target
                      .value
                  )
                }
              />
            </label>


            {/*
             * -----------------------------
             * ROUND 1 + ROUND 2
             * -----------------------------
             */}

            {renderRoundEditor(
              1,
              editorConfig
                .categories
            )}

            {renderRoundEditor(
              2,
              editorConfig
                .round2Categories
            )}


            {/*
             * -----------------------------
             * FINAL ROUND EDITOR
             * -----------------------------
             */}

            <div className="final-editor">
              <div className="final-editor-heading">
                <span>
                  🏆 FINAL ROUND
                </span>

                <h2>
                  Final Round
                </h2>

                <p>
                  Players will see
                  the category before
                  wagering. The clue
                  is revealed only
                  after every wager
                  is locked.
                </p>
              </div>

              <label>
                <span>
                  Final Category
                </span>

                <input
                  type="text"
                  maxLength={
                    100
                  }
                  value={
                    editorConfig
                      .finalRound
                      .category
                  }
                  onChange={(
                    event
                  ) =>
                    updateFinalRound(
                      "category",

                      event
                        .target
                        .value
                    )
                  }
                />
              </label>

              <label>
                <span>
                  Final Clue
                </span>

                <textarea
                  rows={
                    4
                  }
                  maxLength={
                    500
                  }
                  value={
                    editorConfig
                      .finalRound
                      .question
                  }
                  onChange={(
                    event
                  ) =>
                    updateFinalRound(
                      "question",

                      event
                        .target
                        .value
                    )
                  }
                />
              </label>

              <label>
                <span>
                  Final Answer
                </span>

                <textarea
                  rows={
                    3
                  }
                  maxLength={
                    500
                  }
                  value={
                    editorConfig
                      .finalRound
                      .answer
                  }
                  onChange={(
                    event
                  ) =>
                    updateFinalRound(
                      "answer",

                      event
                        .target
                        .value
                    )
                  }
                />
              </label>
            </div>


            {/*
             * EDITOR ACTIONS
             */}

            <div className="editor-actions">
              <button
                type="button"
                onClick={
                  saveToLibrary
                }
              >
                Save to Library
              </button>

              <button
                type="button"
                onClick={
                  startGame
                }
                disabled={
                  !gameState.board ||
                  editorDirty
                }
              >
                Start Game
              </button>
            </div>


            {editorDirty && (
              <p className="editor-help">
                Save your changes
                before starting the
                game.
              </p>
            )}

            {!gameState.board &&
              !editorDirty && (
                <p className="editor-help">
                  Save or load a
                  game before
                  starting.
                </p>
              )}
          </section>
        </>
      )}
    </main>
  );
}


export default App;