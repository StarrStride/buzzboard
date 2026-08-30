import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/*
 * --------------------------------
 * STORAGE LOCATION
 * --------------------------------
 *
 * Local development:
 *   server/data/games.json
 *
 * Railway production:
 *   <mounted volume>/games.json
 *
 * Railway automatically provides
 * RAILWAY_VOLUME_MOUNT_PATH when a
 * persistent volume is attached.
 */

const railwayVolumePath =
  process.env.RAILWAY_VOLUME_MOUNT_PATH
    ?.trim();

const dataDirectory =
  railwayVolumePath
    ? path.resolve(
        railwayVolumePath
      )
    : path.join(
        __dirname,
        "data"
      );

const gamesFile =
  path.join(
    dataDirectory,
    "games.json"
  );


async function ensureStorage() {
  await fs.mkdir(
    dataDirectory,
    {
      recursive: true,
    }
  );

  try {
    await fs.access(
      gamesFile
    );
  } catch {
    await fs.writeFile(
      gamesFile,
      JSON.stringify(
        [],
        null,
        2
      ),
      "utf8"
    );
  }
}


async function writeGames(
  games
) {
  await ensureStorage();

  await fs.writeFile(
    gamesFile,
    JSON.stringify(
      games,
      null,
      2
    ),
    "utf8"
  );
}


export async function getSavedGames() {
  await ensureStorage();

  try {
    const contents =
      await fs.readFile(
        gamesFile,
        "utf8"
      );

    const parsed =
      JSON.parse(
        contents
      );

    if (
      !Array.isArray(
        parsed
      )
    ) {
      return [];
    }

    return parsed;
  } catch (
    error
  ) {
    console.error(
      "Could not read saved games:",
      error
    );

    return [];
  }
}


export async function saveGameToLibrary(
  gameConfig
) {
  const games =
    await getSavedGames();

  const id =
    gameConfig.id ??
    randomUUID();

  const savedGame = {
    ...gameConfig,

    id,

    updatedAt:
      new Date()
        .toISOString(),
  };

  const existingIndex =
    games.findIndex(
      (
        game
      ) =>
        game.id ===
        id
    );

  if (
    existingIndex >=
    0
  ) {
    games[
      existingIndex
    ] =
      savedGame;
  } else {
    games.push(
      savedGame
    );
  }

  await writeGames(
    games
  );

  return savedGame;
}


export async function loadGameFromLibrary(
  id
) {
  const games =
    await getSavedGames();

  return (
    games.find(
      (
        game
      ) =>
        game.id ===
        id
    ) ??
    null
  );
}


export async function deleteGameFromLibrary(
  id
) {
  const games =
    await getSavedGames();

  const filtered =
    games.filter(
      (
        game
      ) =>
        game.id !==
        id
    );

  const deleted =
    filtered.length !==
    games.length;

  if (
    deleted
  ) {
    await writeGames(
      filtered
    );
  }

  return deleted;
}

/* ===== BUZZBOARD CLUE IMAGE STORAGE START ===== */


/*
 * --------------------------------
 * CLUE IMAGE STORAGE
 * --------------------------------
 *
 * Local:
 *   server/data/images/
 *
 * Railway:
 *   <persistent volume>/images/
 *
 * Images are stored separately from
 * games.json so saved-game files stay
 * small and readable.
 */

export const CLUE_IMAGE_MAX_BYTES =
  5 *
  1024 *
  1024;


const clueImageDirectory =
  path.join(
    dataDirectory,
    "images"
  );


const clueImageTypes =
  new Map([
    [
      "image/png",
      {
        extension:
          "png",

        mimeType:
          "image/png",
      },
    ],

    [
      "image/jpeg",
      {
        extension:
          "jpg",

        mimeType:
          "image/jpeg",
      },
    ],

    [
      "image/webp",
      {
        extension:
          "webp",

        mimeType:
          "image/webp",
      },
    ],

    [
      "image/gif",
      {
        extension:
          "gif",

        mimeType:
          "image/gif",
      },
    ],
  ]);


const clueImageMimeByExtension =
  new Map([
    [
      "png",
      "image/png",
    ],

    [
      "jpg",
      "image/jpeg",
    ],

    [
      "webp",
      "image/webp",
    ],

    [
      "gif",
      "image/gif",
    ],
  ]);


async function ensureClueImageStorage() {
  /*
   * ensureStorage() already selects
   * the correct local / Railway
   * persistent data directory.
   */
  await ensureStorage();

  await fs.mkdir(
    clueImageDirectory,
    {
      recursive:
        true,
    }
  );
}


function getSafeClueImageFilename(
  value
) {
  if (
    typeof value !==
    "string"
  ) {
    return null;
  }

  const filename =
    value.trim();

  /*
   * Files are generated from randomUUID(),
   * so only UUID-style names with our
   * supported extensions are accepted.
   *
   * This also prevents path traversal.
   */
  if (
    !/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/i.test(
      filename
    )
  ) {
    return null;
  }

  return filename;
}


export async function saveClueImage(
  contents,
  mimeType
) {
  const imageType =
    clueImageTypes.get(
      mimeType
    );

  if (!imageType) {
    throw new Error(
      "Unsupported clue image type."
    );
  }

  if (
    !Buffer.isBuffer(
      contents
    )
  ) {
    throw new Error(
      "Clue image contents must be a Buffer."
    );
  }

  if (
    contents.length <=
      0
  ) {
    throw new Error(
      "Clue image is empty."
    );
  }

  if (
    contents.length >
      CLUE_IMAGE_MAX_BYTES
  ) {
    throw new Error(
      "Clue image exceeds the 5 MB limit."
    );
  }


  await ensureClueImageStorage();


  const filename =
    `${
      randomUUID()
    }.${
      imageType.extension
    }`;


  const filePath =
    path.join(
      clueImageDirectory,
      filename
    );


  await fs.writeFile(
    filePath,
    contents
  );


  return {
    filename,

    mimeType:
      imageType.mimeType,

    size:
      contents.length,
  };
}


export async function loadClueImage(
  rawFilename
) {
  const filename =
    getSafeClueImageFilename(
      rawFilename
    );

  if (!filename) {
    return null;
  }


  const extension =
    path.extname(
      filename
    )
      .slice(
        1
      )
      .toLowerCase();


  const mimeType =
    clueImageMimeByExtension.get(
      extension
    );


  if (!mimeType) {
    return null;
  }


  await ensureClueImageStorage();


  const filePath =
    path.join(
      clueImageDirectory,
      filename
    );


  try {
    const contents =
      await fs.readFile(
        filePath
      );


    return {
      filename,
      mimeType,
      contents,

      size:
        contents.length,
    };
  }
  catch (error) {
    if (
      error?.code ===
        "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}


/* ===== BUZZBOARD CLUE IMAGE STORAGE END ===== */
