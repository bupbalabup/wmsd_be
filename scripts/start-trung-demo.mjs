// Explicit local-only entry point: no automatic seed or account synchronization.
import 'dotenv/config';
import mongoose from 'mongoose';
const uri='mongodb://127.0.0.1:27017/wmsd_demo_trung_20261112?replicaSet=rs0';
process.env.MONGODB_URI=uri;
await mongoose.connect(uri,{autoCreate:false,autoIndex:false,serverSelectionTimeoutMS:5000});
const hello=await mongoose.connection.db.admin().command({hello:1});
if(!hello.isWritablePrimary||hello.setName!=='rs0')throw new Error('Local rs0 PRIMARY required');
if(!await mongoose.connection.db.collection('defect_reports').findOne({note:/^DEMO Trung/}))throw new Error('Prepare the local Trung demo first');
const {default:app}=await import('../src/app.js');
const {default:express}=await import('express');
const server=express();
server.use((_req,res,next)=>{res.set('X-WMSD-Demo-Database',mongoose.connection.name);next();});
server.use(app);
server.listen(3333,'127.0.0.1',()=>console.info('Trung demo API: http://127.0.0.1:3333 — local wmsd_demo_trung_20261112'));
