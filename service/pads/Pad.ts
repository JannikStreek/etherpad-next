import { AText } from '@/types/PadType';
import { db } from '@/backend/DB';
import { ChangeSet } from '@/service/pads/ChangeSet';
import { AttributePool } from '@/service/pads/AttributePool';
import {
  cleanText,
  makeSplice, opsFromAText,
  randomString,
} from '@/utils/service/utilFuncs';
import {
  addPad,
  getAuthorColorId, getAuthorName,
  getColorPalette,
  removePad,
} from '@/service/pads/AuthorManager';
import Stream from '@/utils/service/Stream';
import { MapArrayType } from '@/types/MapArrayType';
import { strict as assert } from 'assert';
import ChatMessage from '@/service/pads/ChatMessage';
import { padManagerInstance } from '@/service/pads/PadManager';
import CustomError from '@/utils/service/CustomError';
import { timesLimit } from '@/utils/service/promises';
import { getReadOnlyId } from '@/service/pads/ReadOnlyManager';
import { AttributeMap } from '@/service/pads/AttributeMap';
import { doesGroupExist } from '@/service/pads/GroupManager';
import { SmartOpAssembler } from '@/service/pads/SmartOpAssembler';
import { settings } from '@/backend/exportedVars';


export class Pad {
  private db: any;
  private readonly atext: AText;
  private pool: AttributePool;
  private head: number;
  private chatHead: number;
  private publicStatus: boolean;
  private id: string;
  private savedRevisions: any[];

  constructor(id: string, database= db) {
    this.db = database;
    this.atext = ChangeSet.makeAText('\n');
    this.pool = new AttributePool();
    this.head = -1;
    this.chatHead = -1;
    this.publicStatus = false;
    this.id = id;
    this.savedRevisions = [];
  }


  async init(text:string, authorId = '') {
    // try to load the pad
    const value = await this.db.get(`pad:${this.id}`);

    // if this pad exists, load it
    if (value != null) {
      Object.assign(this, value);
      if ('pool' in value) this.pool = new AttributePool().fromJsonable(value.pool);
    } else {
      if (text == null) {
        const context = {pad: this, authorId, type: 'text', content: settings.defaultPadText};
        //TODO await hooks.aCallAll('padDefaultContent', context);
        if (context.type !== 'text') throw new Error(`unsupported content type: ${context.type}`);
        text = cleanText(context.content);
      }
      const firstChangeset = makeSplice('\n', 0, 0, text);
      await this.appendRevision(firstChangeset, authorId);
    }
    //TODO await hooks.aCallAll('padLoad', {pad: this});
  }

  get apool() {
    return this.pool;
  }

  get headRevisionNumber() {
    return this.head;
  }

  get savedRevisionsCount() {
    return this.savedRevisions.length;
  }

  get isPublic() {
    return this.publicStatus;
  }

  async saveToDatabase() {
    // @ts-ignore
    await this.db.set(`pad:${this.id}`, this);
  }

  getKeyRevisionNumber(revNum: number) {
    return Math.floor(revNum / 100) * 100;
  }

  async appendRevision(aChangeset: string, authorId = '') {
    const newAText = ChangeSet.applyToAText(aChangeset,this.atext, this.pool);
    if (newAText.text === this.atext.text && newAText.attribs === this.atext.attribs &&
      this.head !== -1) {
      return this.head;
    }
    ChangeSet.copyAText(newAText, this.atext);

    const newRev = ++this.head;

    // ex. getNumForAuthor
    if (authorId !== '') this.pool.putAttrib(['author', authorId]);

    const hook = this.head === 0 ? 'padCreate' : 'padUpdate';
    await Promise.all([
      // @ts-ignore
      this.db.set(`pad:${this.id}:revs:${newRev}`, {
        changeset: aChangeset,
        meta: {
          author: authorId,
          timestamp: Date.now(),
          ...newRev === this.getKeyRevisionNumber(newRev) ? {
            pool: this.pool,
            atext: this.atext,
          } : {},
        },
      }),
      this.saveToDatabase(),
      authorId && addPad(authorId, this.id),
      // TODO hooks.aCallAll(hook, {
      /*  pad: this,
        authorId,
        get author() {
          warnDeprecated(`${hook} hook author context is deprecated; use authorId instead`);
          return this.authorId;
        },
        set author(authorId) {
          warnDeprecated(`${hook} hook author context is deprecated; use authorId instead`);
          this.authorId = authorId;
        },
        ...this.head === 0 ? {} : {
          revs: newRev,
          changeset: aChangeset,
        },
      }),*/
    ]);
    return newRev;
  }

  toJSON() {
    const o:Pad = {...this, pool: this.pool.toJsonable()};
    // @ts-ignore
    delete o.db;
    // @ts-ignore
    delete o.id;
    return o;
  }

  async getRevisionChangeset(revNum: number) {
    // @ts-ignore
    return await this.db.getSub(`pad:${this.id}:revs:${revNum}`, ['changeset']);
  }

  async getRevisionAuthor(revNum: number) {
    // @ts-ignore
    return await this.db.getSub(`pad:${this.id}:revs:${revNum}`, ['meta', 'author']);
  }

  async getRevisionDate(revNum: number) {
    // @ts-ignore
    return await this.db.getSub(`pad:${this.id}:revs:${revNum}`, ['meta', 'timestamp']);
  }

  /**
   * @param {number} revNum - Must be a key revision number (see `getKeyRevisionNumber`).
   * @returns The attribute text stored at `revNum`.
   */
  async _getKeyRevisionAText(revNum: number) {
    // @ts-ignore
    return await this.db.getSub(`pad:${this.id}:revs:${revNum}`, ['meta', 'atext']);
  }

  /**
   * Returns all authors that worked on this pad
   * @return {[String]} The id of authors who contributed to this pad
   */
  getAllAuthors() {
    const authorIds = [];

    for (const key in this.pool.numToAttrib) {
      if (this.pool.numToAttrib[key][0] === 'author' && this.pool.numToAttrib[key][1] !== '') {
        authorIds.push(this.pool.numToAttrib[key][1]);
      }
    }

    return authorIds;
  }

  async getInternalRevisionAText(targetRev: number) {
    const keyRev = this.getKeyRevisionNumber(targetRev);
    const headRev = this.headRevisionNumber;
    if (targetRev > headRev) targetRev = headRev;
    const [keyAText, changesets] = await Promise.all([
      this._getKeyRevisionAText(keyRev),
      Promise.all(
        Stream.range(keyRev + 1, targetRev + 1).map(this.getRevisionChangeset.bind(this))),
    ]);
    const apool = this.apool;
    let atext = keyAText;
    for (const cs of changesets) atext = ChangeSet.applyToAText(cs, atext, apool);
    return atext;
  }

  async getRevision(revNum: number) {
    return await this.db.get(`pad:${this.id}:revs:${revNum}`);
  }

  async getAllAuthorColors() {
    const authorIds = this.getAllAuthors();
    const returnTable:MapArrayType<any> = {};
    const colorPalette = getColorPalette();

    await Promise.all(
      authorIds.map((authorId) => getAuthorColorId(authorId).then((colorId:number) => {
        // colorId might be a hex color or an number out of the palette
        returnTable[authorId] = colorPalette[colorId] || colorId;
      })));

    return returnTable;
  }

  getValidRevisionRange(startRev: any, endRev:any) {
    startRev = parseInt(startRev, 10);
    const head = this.headRevisionNumber;
    endRev = endRev ? parseInt(endRev, 10) : head;

    if (isNaN(startRev) || startRev < 0 || startRev > head) {
      startRev = null;
    }

    if (isNaN(endRev) || endRev < startRev) {
      endRev = null;
    } else if (endRev > head) {
      endRev = head;
    }

    if (startRev != null && endRev != null) {
      return {startRev, endRev};
    }
    return null;
  }

  /**
   * @returns {string} The pad's text.
   */
  text(): string {
    return this.atext.text;
  }

  /**
   * Splices text into the pad. If the result of the splice does not end with a newline, one will be
   * automatically appended.
   *
   * @param {number} start - Location in pad text to start removing and inserting characters. Must
   *     be a non-negative integer less than or equal to `this.text().length`.
   * @param {number} ndel - Number of characters to remove starting at `start`. Must be a
   *     non-negative integer less than or equal to `this.text().length - start`.
   * @param {string} ins - New text to insert at `start` (after the `ndel` characters are deleted).
   * @param {string} [authorId] - Author ID of the user making the change (if applicable).
   */
  async spliceText(start:number, ndel:number, ins: string, authorId: string = '') {
    if (start < 0) throw new RangeError(`start index must be non-negative (is ${start})`);
    if (ndel < 0) throw new RangeError(`characters to delete must be non-negative (is ${ndel})`);
    const orig = this.text();
    assert(orig.endsWith('\n'));
    if (start + ndel > orig.length) throw new RangeError('start/delete past the end of the text');
    ins = cleanText(ins);
    const willEndWithNewline =
      start + ndel < orig.length || // Keeping last char (which is guaranteed to be a newline).
      ins.endsWith('\n') ||
      (!ins && start > 0 && orig[start - 1] === '\n');
    if (!willEndWithNewline) ins += '\n';
    if (ndel === 0 && ins.length === 0) return;
    const changeset = makeSplice(orig, start, ndel, ins);
    await this.appendRevision(changeset, authorId);
  }

  /**
   * Replaces the pad's text with new text.
   *
   * @param {string} newText - The pad's new text. If this string does not end with a newline, one
   *     will be automatically appended.
   * @param {string} [authorId] - The author ID of the user that initiated the change, if
   *     applicable.
   */
  async setText(newText: string, authorId = '') {
    await this.spliceText(0, this.text().length, newText, authorId);
  }

  /**
   * Appends text to the pad.
   *
   * @param {string} newText - Text to insert just BEFORE the pad's existing terminating newline.
   * @param {string} [authorId] - The author ID of the user that initiated the change, if
   *     applicable.
   */
  async appendText(newText:string, authorId = '') {
    await this.spliceText(this.text().length - 1, 0, newText, authorId);
  }

  /**
   * Adds a chat message to the pad, including saving it to the database.
   *
   * @param {(ChatMessage|string)} msgOrText - Either a chat message object (recommended) or a
   *     string containing the raw text of the user's chat message (deprecated).
   * @param {?string} [authorId] - The user's author ID. Deprecated; use `msgOrText.authorId`
   *     instead.
   * @param {?number} [time] - Message timestamp (milliseconds since epoch). Deprecated; use
   *     `msgOrText.time` instead.
   */
  async appendChatMessage(msgOrText: string|ChatMessage, authorId = null, time = null) {
    const msg =
      msgOrText instanceof ChatMessage ? msgOrText : new ChatMessage(msgOrText, authorId, time);
    this.chatHead++;
    await Promise.all([
      // Don't save the display name in the database because the user can change it at any time. The
      // `displayName` property will be populated with the current value when the message is read
      // from the database.
      this.db.set(`pad:${this.id}:chat:${this.chatHead}`, {...msg, displayName: undefined}),
      this.saveToDatabase(),
    ]);
  }

  /**
   * @param {number} entryNum - ID of the desired chat message.
   * @returns {?ChatMessage}
   */
  async getChatMessage(entryNum: number) {
    const entry = await this.db.get(`pad:${this.id}:chat:${entryNum}`);
    if (entry == null) return null;
    const message = ChatMessage.fromObject(entry);
    message.displayName = await getAuthorName(message.authorId!);
    return message;
  }

  /**
   * @param {number} start - ID of the first desired chat message.
   * @param {number} end - ID of the last desired chat message.
   * @returns {ChatMessage[]} Any existing messages with IDs between `start` (inclusive) and `end`
   *     (inclusive), in order. Note: `start` and `end` form a closed interval, not a half-open
   *     interval as is typical in code.
   */
  async getChatMessages(start: number, end: number) {
    const entries =
      await Promise.all(Stream.range(start, end + 1).map(this.getChatMessage.bind(this)));

    // sort out broken chat entries
    // it looks like in happened in the past that the chat head was
    // incremented, but the chat message wasn't added
    return entries.filter((entry) => {
      const pass = (entry != null);
      if (!pass) {
        console.warn(`WARNING: Found broken chat entry in pad ${this.id}`);
      }
      return pass;
    });
  }

  async copy(destinationID: string, force: boolean) {
    // Kick everyone from this pad.
    // This was commented due to https://github.com/ether/etherpad-lite/issues/3183.
    // Do we really need to kick everyone out?
    // padMessageHandler.kickSessionsFromPad(sourceID);

    // flush the source pad:
    await this.saveToDatabase();

    // if it's a group pad, let's make sure the group exists.
    const destGroupID = await this.checkIfGroupExistAndReturnIt(destinationID);

    // if force is true and already exists a Pad with the same id, remove that Pad
    await this.removePadIfForceIsTrueAndAlreadyExist(destinationID, force);

    const copyRecord = async (keySuffix: string) => {
      const val = await this.db.get(`pad:${this.id}${keySuffix}`);
      await db!.set(`pad:${destinationID}${keySuffix}`, val);
    };

    const promises = (function* () {
      yield copyRecord('');
      // @ts-ignore
      yield* Stream.range(0, this.head + 1).map((i) => copyRecord(`:revs:${i}`));
      // @ts-ignore
      yield* Stream.range(0, this.chatHead + 1).map((i) => copyRecord(`:chat:${i}`));
      // @ts-ignore
      yield this.copyAuthorInfoToDestinationPad(destinationID);
      if (destGroupID) { // @ts-ignore
        yield db!.setSub(`group:${destGroupID}`, ['pads', destinationID], 1);
      }
    }).call(this);
    for (const p of new Stream(promises).batch(100).buffer(99)) await p;

    // Initialize the new pad (will update the listAllPads cache)
    const dstPad = await padManagerInstance.getPad(destinationID, null);

    /* TODO // let the plugins know the pad was copied
    await hooks.aCallAll('padCopy', {
      get originalPad() {
        warnDeprecated('padCopy originalPad context property is deprecated; use srcPad instead');
        return this.srcPad;
      },
      get destinationID() {
        warnDeprecated(
          'padCopy destinationID context property is deprecated; use dstPad.id instead');
        return this.dstPad.id;
      },
      srcPad: this,
      dstPad,
    });*/

    return {padID: destinationID};
  }

  async copyAuthorInfoToDestinationPad(destinationID: string) {
    // add the new sourcePad to all authors who contributed to the old one
    await Promise.all(this.getAllAuthors().map(
      (authorID) => addPad(authorID, destinationID)));
  }

  async copyPadWithoutHistory(destinationID: string, force: string|boolean, authorId = '') {
    // flush the source pad
    await this.saveToDatabase();

    // if it's a group pad, let's make sure the group exists.
    const destGroupID = await this.checkIfGroupExistAndReturnIt(destinationID);

    // if force is true and already exists a Pad with the same id, remove that Pad
    await this.removePadIfForceIsTrueAndAlreadyExist(destinationID, force);

    await this.copyAuthorInfoToDestinationPad(destinationID);

    // Group pad? Add it to the group's list
    if (destGroupID) {
      // @ts-ignore
      await db!.setSub(`group:${destGroupID}`, ['pads', destinationID], 1);
    }

    // initialize the pad with a new line to avoid getting the defaultText
    const dstPad = await padManagerInstance.getPad(destinationID, '\n', authorId);
    dstPad.pool = this.pool.clone();

    const oldAText = this.atext;

    // based on Changeset.makeSplice
    const assem = new SmartOpAssembler();
    for (const op of opsFromAText(oldAText)) assem.append(op);
    assem.endDocument();

    // although we have instantiated the dstPad with '\n', an additional '\n' is
    // added internally, so the pad text on the revision 0 is "\n\n"
    const oldLength = 2;

    const newLength = assem.getLengthChange();
    const newText = oldAText.text;

    // create a changeset that removes the previous text and add the newText with
    // all atributes present on the source pad
    const changeset = ChangeSet.pack(oldLength, newLength, assem.toString(), newText);
    await dstPad.appendRevision(changeset, authorId);

    /*await hooks.aCallAll('padCopy', {
      get originalPad() {
        warnDeprecated('padCopy originalPad context property is deprecated; use srcPad instead');
        return this.srcPad;
      },
      get destinationID() {
        warnDeprecated(
          'padCopy destinationID context property is deprecated; use dstPad.id instead');
        return this.dstPad.id;
      },
      srcPad: this,
      dstPad,
    });*/

    return {padID: destinationID};
  }

  async checkIfGroupExistAndReturnIt(destinationID: string) {
    let destGroupID:false|string = false;

    if (destinationID.indexOf('$') >= 0) {
      destGroupID = destinationID.split('$')[0];
      const groupExists = await doesGroupExist(destGroupID);

      // group does not exist
      if (!groupExists) {
        throw new CustomError('groupID does not exist for destinationID', 'apierror');
      }
    }
    return destGroupID;
  }

  async remove() {
    const padID = this.id;
    const p = [];

    // kick everyone from this pad
    // TODO padMessageHandler.kickSessionsFromPad(padID);

    // delete all relations - the original code used async.parallel but
    // none of the operations except getting the group depended on callbacks
    // so the database operations here are just started and then left to
    // run to completion

    // is it a group pad? -> delete the entry of this pad in the group
    if (padID.indexOf('$') >= 0) {
      // it is a group pad
      const groupID = padID.substring(0, padID.indexOf('$'));
      const group = await db!.get(`group:${groupID}`);

      // remove the pad entry
      delete group.pads[padID];

      // set the new value
      p.push(db!.set(`group:${groupID}`, group));
    }

    // remove the readonly entries
    p.push(getReadOnlyId(padID).then(async (readonlyID: string) => {
      await db!.remove(`readonly2pad:${readonlyID}`);
    }));
    p.push(db!.remove(`pad2readonly:${padID}`));

    // delete all chat messages
    p.push(timesLimit(this.chatHead + 1, 500, async (i: string) => {
      await this.db.remove(`pad:${this.id}:chat:${i}`, null);
    }));

    // delete all revisions
    p.push(timesLimit(this.head + 1, 500, async (i: string) => {
      await this.db.remove(`pad:${this.id}:revs:${i}`, null);
    }));

    // remove pad from all authors who contributed
    this.getAllAuthors().forEach((authorId) => {
      p.push(removePad(authorId, padID));
    });

    // delete the pad entry and delete pad from padManager
    p.push(padManagerInstance.removePad(padID));
    //TODO p.push(hooks.aCallAll('padRemove', {
    /*  get padID() {
        warnDeprecated('padRemove padID context property is deprecated; use pad.id instead');
        return this.pad.id;
      },
      pad: this,
    }));*/
    await Promise.all(p);
  }

  async setPublicStatus(publicStatus: boolean) {
    this.publicStatus = publicStatus;
    await this.saveToDatabase();
  }

  async addSavedRevision(revNum: string, savedById: string, label: string) {
    // if this revision is already saved, return silently
    for (const i in this.savedRevisions) {
      if (this.savedRevisions[i] && this.savedRevisions[i].revNum === revNum) {
        return;
      }
    }

    // build the saved revision object
    const savedRevision:MapArrayType<any> = {};
    savedRevision.revNum = revNum;
    savedRevision.savedById = savedById;
    savedRevision.label = label || `Revision ${revNum}`;
    savedRevision.timestamp = Date.now();
    savedRevision.id = randomString(10);

    // save this new saved revision
    this.savedRevisions.push(savedRevision);
    await this.saveToDatabase();
  }

  getSavedRevisions() {
    return this.savedRevisions;
  }

  getSavedRevisionsList() {
    const savedRev = this.savedRevisions.map((rev) => rev.revNum);
    savedRev.sort((a, b) => a - b);
    return savedRev;
  }

  getSavedRevisionsNumber() {
    return this.savedRevisions.length;
  }

  /**
   * Asserts that all pad data is consistent. Throws if inconsistent.
   */
  async check() {
    assert(this.id != null);
    assert.equal(typeof this.id, 'string');

    const head = this.headRevisionNumber;
    assert(head != null);
    assert(Number.isInteger(head));
    assert(head >= -1);

    const savedRevisionsList = this.getSavedRevisionsList();
    assert(Array.isArray(savedRevisionsList));
    assert.equal(this.getSavedRevisionsNumber(), savedRevisionsList.length);
    let prevSavedRev = null;
    for (const rev of savedRevisionsList) {
      assert(rev != null);
      assert(Number.isInteger(rev));
      assert(rev >= 0);
      assert(rev <= head);
      assert(prevSavedRev == null || rev > prevSavedRev);
      prevSavedRev = rev;
    }
    const savedRevisions = this.getSavedRevisions();
    assert(Array.isArray(savedRevisions));
    assert.equal(savedRevisions.length, savedRevisionsList.length);
    const savedRevisionsIds = new Set();
    for (const savedRev of savedRevisions) {
      assert(savedRev != null);
      assert.equal(typeof savedRev, 'object');
      assert(savedRevisionsList.includes(savedRev.revNum));
      assert(savedRev.id != null);
      assert.equal(typeof savedRev.id, 'string');
      assert(!savedRevisionsIds.has(savedRev.id));
      savedRevisionsIds.add(savedRev.id);
    }

    const pool = this.apool;
    assert(pool instanceof AttributePool);
    pool.check();

    const authorIds = new Set();
    pool.eachAttrib((k:string, v:string) => {
      if (k === 'author' && v) authorIds.add(v);
    });
    const revs = Stream.range(0, head + 1)
      .map(async (r: number) => {
        const isKeyRev = r === this.getKeyRevisionNumber(r);
        try {
          return await Promise.all([
            r,
            this.getRevisionChangeset(r),
            this.getRevisionAuthor(r),
            this.getRevisionDate(r),
            isKeyRev,
            isKeyRev ? this._getKeyRevisionAText(r) : null,
          ]);
        } catch (err:any) {
          err.message = `(pad ${this.id} revision ${r}) ${err.message}`;
          throw err;
        }
      })
      .batch(100).buffer(99);
    let atext = ChangeSet.makeAText('\n');
    for await (const [r, changeset, authorId, timestamp, isKeyRev, keyAText] of revs) {
      try {
        assert(authorId != null);
        assert.equal(typeof authorId, 'string');
        if (authorId) authorIds.add(authorId);
        assert(timestamp != null);
        assert.equal(typeof timestamp, 'number');
        assert(timestamp > 0);
        assert(changeset != null);
        assert.equal(typeof changeset, 'string');
        ChangeSet.checkRep(changeset);
        const unpacked = ChangeSet.unpack(changeset);
        let text = atext.text;
        for (const op of ChangeSet.deserializeOps(unpacked.ops)) {
          if (['=', '-'].includes(op.opcode)) {
            assert(text.length >= op.chars);
            const consumed = text.slice(0, op.chars);
            const nlines = (consumed.match(/\n/g) || []).length;
            assert.equal(op.lines, nlines);
            if (op.lines > 0) assert(consumed.endsWith('\n'));
            text = text.slice(op.chars);
          }
          assert.equal(op.attribs, AttributeMap.fromString(op.attribs, pool).toString());
        }
        atext = ChangeSet.applyToAText(changeset, atext, pool);
        if (isKeyRev) assert.deepEqual(keyAText, atext);
      } catch (err:any) {
        err.message = `(pad ${this.id} revision ${r}) ${err.message}`;
        throw err;
      }
    }
    assert.equal(this.text(), atext.text);
    assert.deepEqual(this.atext, atext);
    assert.deepEqual(this.getAllAuthors().sort(), [...authorIds].sort());

    assert(this.chatHead != null);
    assert(Number.isInteger(this.chatHead));
    assert(this.chatHead >= -1);
    const chats = Stream.range(0, this.chatHead + 1)
      .map(async (c: number) => {
        try {
          const msg = await this.getChatMessage(c);
          assert(msg != null);
          assert(msg instanceof ChatMessage);
        } catch (err:any) {
          err.message = `(pad ${this.id} chat message ${c}) ${err.message}`;
          throw err;
        }
      })
      .batch(100).buffer(99);
    for (const p of chats) await p;

    //TODO await hooks.aCallAll('padCheck', {pad: this});
  }

  async removePadIfForceIsTrueAndAlreadyExist(destinationID: string, force: boolean|string) {
    // if the pad exists, we should abort, unless forced.
    const exists = await padManagerInstance.doesPadExist(destinationID);

    // allow force to be a string
    if (typeof force === 'string') {
      force = (force.toLowerCase() === 'true');
    } else {
      force = !!force;
    }

    if (exists) {
      if (!force) {
        console.error('erroring out without force');
        throw new CustomError('destinationID already exists', 'apierror');
      }

      // exists and forcing
      const pad = await padManagerInstance.getPad(destinationID);
      await pad.remove();
    }
  }
}
