import { ObjectID } from 'mongodb';
import { PermissionError } from '../error';
import { PERM } from '../model/builtin';
import * as problem from '../model/problem';
import * as record from '../model/record';
import * as contest from '../model/contest';
import * as system from '../model/system';
import * as user from '../model/user';
import paginate from '../lib/paginate';
import * as bus from '../service/bus';
import {
    Route, Handler, Connection, ConnectionHandler, Types, param,
} from '../service/server';

const RecordHandler = contest.ContestHandlerMixin(Handler);

class RecordListHandler extends RecordHandler {
    @param('page', Types.UnsignedInt, true)
    @param('pid', Types.String, true)
    @param('tid', Types.ObjectID, true)
    @param('uidOrName', Types.String, true)
    async get(domainId: string, page = 1, pid?: string, tid?: ObjectID, uidOrName?: string) {
        this.response.template = 'record_main.html';
        if (tid) tid = new ObjectID(tid);
        const q: any = { tid, hidden: false };
        if (uidOrName) {
            q.$or = [
                { unameLower: uidOrName.toLowerCase() },
                { _id: parseInt(uidOrName, 10) },
            ];
        }
        if (pid) q.pid = pid;
        const [rdocs] = await paginate(
            record.getMulti(domainId, q).sort('_id', -1),
            page,
            await system.get('RECORD_PER_PAGE'),
        );
        const [udict, pdict] = await Promise.all([
            user.getList(domainId, rdocs.map((rdoc) => rdoc.uid)),
            problem.getList(domainId, rdocs.map((rdoc) => rdoc.pid), false, false),
        ]);
        const path = [
            ['Hydro', 'homepage'],
            ['record_main', null],
        ];
        this.response.body = {
            path,
            page,
            rdocs,
            pdict,
            udict,
            fliterPid: pid,
            fliterTid: tid,
            fliterUidOrName: uidOrName,
        };
    }
}

class RecordDetailHandler extends RecordHandler {
    @param('rid', Types.ObjectID)
    async get(domainId: string, rid: ObjectID) {
        this.response.template = 'record_detail.html';
        const rdoc = await record.get(domainId, rid);
        if (rdoc.tid) {
            const tdoc = await contest.get(domainId, rdoc.tid, rdoc.ttype);
            if (!this.canShowRecord(tdoc, true)) throw new PermissionError(rid);
        }
        if (rdoc.uid !== this.user.uid && !this.user.hasPerm(PERM.PERM_READ_RECORD_CODE)) {
            rdoc.code = null;
        }
        if (rdoc.type !== 'run') rdoc.stdout = rdoc.stderr = '';
        const [pdoc, udoc] = await Promise.all([
            problem.get(domainId, rdoc.pid, null, false),
            user.getById(domainId, rdoc.uid),
        ]);
        this.response.body = {
            path: [
                ['Hydro', 'homepage'],
                ['record_detail', null],
            ],
            udoc,
            rdoc,
            pdoc,
            // TODO protect
            showStatus: true,
        };
    }
}

class RecordRejudgeHandler extends Handler {
    @param('rid', Types.ObjectID)
    async post(domainId: string, rid: ObjectID) {
        this.checkPerm(PERM.PERM_REJUDGE);
        const rdoc = await record.get(domainId, rid);
        if (rdoc) await record.rejudge(domainId, rid);
        this.back();
    }
}

const RecordConnectionHandler = contest.ContestHandlerMixin(ConnectionHandler);

class RecordMainConnectionHandler extends RecordConnectionHandler {
    @param('tid', Types.ObjectID)
    async prepare(domainId: string, tid: ObjectID) {
        this.domainId = domainId;
        if (tid) {
            const tdoc = await contest.get(domainId, new ObjectID(tid), -1);
            if (this.canShowRecord(tdoc)) this.tid = tid;
            else {
                this.close();
                return;
            }
        }
        bus.subscribe(['record_change'], this, 'onRecordChange');
    }

    async message(msg) {
        if (msg.rids instanceof Array) {
            const rdocs = await record.getMulti(
                this.domainId, { _id: { $in: msg.rids.map((id) => new ObjectID(id)) } },
            ).toArray();
            for (const rdoc of rdocs) {
                this.onRecordChange({ value: rdoc });
            }
        }
    }

    async cleanup() {
        bus.unsubscribe(['record_change'], this, 'onRecordChange');
    }

    async onRecordChange(data) {
        const rdoc = data.value;
        if (rdoc.tid && rdoc.tid.toString() !== this.tid) return;
        // eslint-disable-next-line prefer-const
        let [udoc, pdoc] = await Promise.all([
            user.getById(this.domainId, rdoc.uid),
            problem.get(this.domainId, rdoc.pid, null, false),
        ]);
        if (pdoc && pdoc.hidden && !this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) pdoc = null;
        this.send({ html: await this.renderHTML('record_main_tr.html', { rdoc, udoc, pdoc }) });
    }
}

class RecordDetailConnectionHandler extends contest.ContestHandlerMixin(ConnectionHandler) {
    @param('rid', Types.ObjectID)
    async prepare(domainId: string, rid: ObjectID) {
        const rdoc = await record.get(domainId, rid);
        if (rdoc.tid) {
            const tdoc = await contest.get(domainId, rdoc.tid, -1);
            if (!this.canShowRecord(tdoc)) {
                this.close();
                return;
            }
        }
        this.rid = rid.toString();
        bus.subscribe(['record_change'], this, 'onRecordChange');
        this.onRecordChange({ value: rdoc });
    }

    async onRecordChange(data) {
        const rdoc = data.value;
        if (rdoc._id.toString() !== this.rid) return;
        this.send({
            status_html: await this.renderHTML('record_detail_status.html', { rdoc }),
            summary_html: await this.renderHTML('record_detail_summary.html', { rdoc }),
        });
    }

    async cleanup() {
        bus.unsubscribe(['record_change'], this, 'onRecordChange');
    }
}

export async function apply() {
    Route('record_main', '/record', RecordListHandler);
    Route('record_detail', '/record/:rid', RecordDetailHandler);
    Route('record_rejudge', '/record/:rid/rejudge', RecordRejudgeHandler);
    Connection('record_conn', '/record-conn', RecordMainConnectionHandler);
    Connection('record_detail_conn', '/record-detail-conn', RecordDetailConnectionHandler);
}

global.Hydro.handler.record = apply;
