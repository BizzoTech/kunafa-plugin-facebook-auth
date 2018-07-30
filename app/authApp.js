const express = require('express');
const bodyParser = require('body-parser');
const process = require('process');
const graph = require('fbgraph');
graph.setVersion("2.8");
graph.setAppSecret(process.env.FBSECRET);

const uuid = require('uuid');
const generatePassword = require('password-generator');

const nano = require('nano');
const Promise = require("bluebird");

const COUCHDB_USER = process.env.COUCHDB_USER;
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD;

const publicDb = nano(`http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@public-db:5984`).use("public");
const mainDb = nano(`http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@main-db:5984`).use("db");
const usersDb = nano(`http://${COUCHDB_USER}:${COUCHDB_PASSWORD}@auth-db:5984`).use("_users");

const profileAlreadyCreated = async (profileId) => {
  try {
    const doc = await publicDb.get(profileId);
    return !!doc;
  } catch (err) {
    if (err.statusCode == 404) {
      return false;
    }
    throw err;
  }
}

const removeOldSessions = async (profileId) => {
  try {
    const sessions = await usersDb.find({
      selector: {
        profileId
      }
    });
    if (!sessions.docs || sessions.docs.length === 0) {
      return;
    }
    const deletedSessions = sessions.docs.map(doc => {
      return {
        _id: doc._id,
        _rev: doc._rev,
        _deleted: true
      }
    });
    return await usersDb.bulk({docs: deletedSessions});
  } catch (err) {
    throw err;
  }
}

function getUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const profileRequestParams = {
      fields: 'picture,name,first_name,birthday,education,hometown,email,is_verified,languages,last_name,locale,location,middle_name,name_format,political,quotes,relationship_status,religion,sports,about,gender,id,timezone,link,age_range',
      access_token: accessToken
    }
    graph.get("/me", profileRequestParams, (error, result) => {
      if (error) {
        return reject(error);
      } else {
        return resolve(result);
      }
    });
  }).then(user => {

    user.image = {
      uri: `https://avatars.io/facebook/${user.id}`,
      resized: [
        {
          size: 48,
          uri: `https://avatars.io/facebook/${user.id}/small`
        },
        {
          size: 130,
          uri: `https://avatars.io/facebook/${user.id}/meduim`
        },
        {
          size: 256,
          uri: `https://avatars.io/facebook/${user.id}/large`
        }
      ]
    }

    return user;
  });
}

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/facebook', async (req, res, next) => {

  try {
    const accessToken = req.body.accessToken;
    const result = await getUserInfo(accessToken);
    const name = 'fbuser' + result.id + "_" + uuid.v4();
    const password = generatePassword(20, false);

    const profile = result;
    profile._id = "profile_" +
      'fbuser' + result.id;
    profile.fbId = profile.id;
    profile.id = undefined;
    profile.type = "profile";

    const user = {
      _id: "org.couchdb.user:" + name,
      name,
      roles: [],
      type: "user",
      password,
      profileId: profile._id
    };

    const event = {
      "_id": `${profile._id}-${Date.now()}-ADD_PROFILE`,
      "createdBy": "Server",
      "status": "draft",
      "action": {
        "type": "ADD_PROFILE",
        "doc": profile
      },
      "preProcessors": [],
      "relevantDocsIds": [profile._id],
      "type": "EVENT",
      "postProcessors": [],
      "createdAt": Date.now()
    }

    await removeOldSessions(profile._id);
    await usersDb.insert(user);

    if (await profileAlreadyCreated(profile._id)) {
      res.json({ name, password, profileId: profile._id });
    } else {
      await mainDb.insert(event);
      res.json({ name, password, profileId: profile._id, event });
    }
  } catch (e) {
    console.log(e);
    res.json(e);
  }
});

app.listen(3000, function () {
  console.log('Auth app listening on port 3000!')
})
