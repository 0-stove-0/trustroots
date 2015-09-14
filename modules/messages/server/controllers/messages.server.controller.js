'use strict';

/**
 * Module dependencies.
 */
var _ = require('lodash'),
    path = require('path'),
    errorHandler = require(path.resolve('./modules/core/server/controllers/errors.server.controller')),
    textProcessor = require(path.resolve('./modules/core/server/controllers/text-processor.server.controller')),
    userHandler = require(path.resolve('./modules/users/server/controllers/users.server.controller')),
    async = require('async'),
    sanitizeHtml = require('sanitize-html'),
    paginate = require('express-paginate'),
    mongoose = require('mongoose'),
    Message = mongoose.model('Message'),
    Thread = mongoose.model('Thread'),
    User = mongoose.model('User');


// Constructs link headers for pagination
var setLinkHeader = function(req, res, pageCount) {
  if (paginate.hasNextPages(req)(pageCount)){
    var nextPage = {page: req.query.page + 1};
    var linkHead = '<' + req.protocol + ':' + res.locals.url.slice(0,-1) + res.locals.paginate.href(nextPage) + '>; rel="next"';
    res.set('Link',linkHead);
  }
};

/**
 * List of threads aka inbox
 */
exports.inbox = function(req, res) {

  Thread.paginate(
    {
      // Returns only threads where currently authenticated user is participating member
      $or: [
        { userFrom: req.user },
        { userTo: req.user }
      ]
    },
    req.query.page,
    req.query.limit,
    function(err, pageCount, threads) {
      if (err) {
        return res.status(400).send({
          message: errorHandler.getErrorMessage(err)
        });
      } else {

        // Sanitize each outgoing thread
        var threadsCleaned = [];
        threads.forEach(function(thread) {

          // Threads need just excerpt
          thread = thread.toObject();

          thread.message.excerpt = textProcessor.plainText(thread.message.content, true); // Clean message content from html + clean all whitespace
          thread.message.excerpt = thread.message.excerpt.substring(0, 100) + ' …'; // Shorten

          delete thread.message.content;

          // If latest message in the thread was from current user, show
          // it as read - sender obviously read his/her own message
          if(thread.userFrom._id.toString() === req.user._id.toString()) {
            thread.read = true;
          }

          threadsCleaned.push(thread);
        });

        // Pass pagination data to construct link header
        setLinkHeader(req, res, pageCount);

        res.json(threadsCleaned);
      }
    },
    {
      sortBy:'-updated',
      populate:{
        path: 'userFrom userTo message',
        select: 'content ' + userHandler.userMiniProfileFields
      }
    }
  );
};



/**
 * Send a message
 */
exports.send = function(req, res) {

  // Not a valid ObjectId
  if(!mongoose.Types.ObjectId.isValid(req.body.userTo)) {
    return res.status(400).send({
      message: errorHandler.getErrorMessageByKey('invalid-id')
    });
  }

  // Don't allow sending messages to myself
  if(req.user._id.equals(req.body.userTo)) {
    return res.status(403).send({
      message: 'Recepient cannot be currently authenticated user.'
    });
  }

  // Test in case content is actually empty without html
  if(textProcessor.isEmpty(req.body.content)) {
    return res.status(400).send({
      message: 'Please write a message.'
    });
  }

  var message = new Message(req.body);

  // Allow some HTML
  message.content = textProcessor.html(message.content);

  message.userFrom = req.user;
  message.read = false;
  message.notified = false;

  message.save(function(err) {
    if (err) {
      return res.status(400).send({
        message: errorHandler.getErrorMessage(err)
      });
    } else {

      // Create/upgrade Thread handle between these two users
      var thread = new Thread();
      thread.updated = Date.now();
      thread.userFrom = message.userFrom;
      thread.userTo = message.userTo;
      thread.message = message;
      thread.read = false;

      // Convert the Model instance to a simple object using Model's 'toObject' function
      // to prevent weirdness like infinite looping...
      var upsertData = thread.toObject();

      // Delete the _id property, otherwise Mongo will return a "Mod on _id not allowed" error
      delete upsertData._id;

      // Do the upsert, which works like this: If no Thread document exists with
      // _id = thread.id, then create a new doc using upsertData.
      // Otherwise, update the existing doc with upsertData
      // @link http://stackoverflow.com/a/7855281
      Thread.update({
        // User id's can be either way around in old thread handle, so we gotta test for both situations
        $or: [
          {
            userTo: upsertData.userTo,
            userFrom: upsertData.userFrom
          },
          {
            userTo: upsertData.userFrom,
            userFrom: upsertData.userTo
          }
        ]
      },
      upsertData,
      { upsert: true },
      function(err) {
        if (err) {
          return res.status(400).send({
            message: errorHandler.getErrorMessage(err)
          });
        }
      });

      // We'll need some info about related users, populate some fields
      message
        .populate('userFrom', userHandler.userMiniProfileFields)
        .populate({
          path: 'userTo',
          select: userHandler.userMiniProfileFields
        }, function(err, message) {
          if (err) {
            return res.status(400).send({
              message: errorHandler.getErrorMessage(err)
            });
          } else {

            // Finally res
            res.json(message);
          }
        });

    }
  });
};


/**
 * Thread of messages
 */
exports.thread = function(req, res) {
  res.json(req.messages || []);
};

/**
 * Thread middleware
 */
exports.threadByUser = function(req, res, next, userId) {

  async.waterfall([

    // Find messages
    function(done) {

      if(!req.user) {
        return res.status(403).send({
          message: errorHandler.getErrorMessageByKey('forbidden')
        });
      }

      // Not user id or its not a valid ObjectId
      if(!userId || !mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).send({
          message: errorHandler.getErrorMessageByKey('invalid-id')
        });
      }

      Message.paginate(
        {
          $or: [
            { userFrom: req.user._id, userTo: userId },
            { userTo: req.user._id, userFrom: userId }
          ]
        },
        req.query.page,
        req.query.limit,
        function(err, pageCount, messages) {
          if (!messages) err = new Error('Failed to load messages.');
          // Pass pagination data to construct link header
          setLinkHeader(req,res,pageCount);
          done(err, messages);
        },
        {
          sortBy:'-created',
          populate: {
            path:'userFrom userTo',
            select: userHandler.userMiniProfileFields
          }
        }
      );

    },

    // Sanitize messages and return them for the API
    function(messages, done) {

      var messagesCleaned = [];

      if(messages && messages.length > 0) {
        // Sanitize each outgoing message's contents
        messages.forEach(function(message) {
          message.content = sanitizeHtml(message.content, textProcessor.sanitizeOptions);
          messagesCleaned.push(message);
        });
      }

      req.messages = messagesCleaned;

      done(null);
    },

    /* Mark the thread read
     *
     * @todo: mark it read:true only when it was read:false,
     * now it performs write each time thread is opened
     */
    function(done) {

      if(req.messages && req.messages.length > 0) {

        var recentMessage = _.first(req.messages);

        // If latest message in the thread was to current user, mark thread read
        if(recentMessage.userTo._id.toString() === req.user._id.toString()) {

          Thread.update(
            {
              userTo: req.user._id,
              userFrom: userId
            },
            {
              read: true
            },
            // Options:
            {
              multi: false
            },
            function(err){
              done(err);
            }
          );

        } else {
          done(null);
        }

      } else {
        done(null);
      }

    }

  ], function(err) {
      if (err) {
        return res.status(400).send({
          message: errorHandler.getErrorMessage(err)
        });
      }
      else return next();
  });

};


/**
 * Mark set of messages as read
 * Works only for currently logged in user's messages
 *
 * @todo: when array has only one id, as a small
 * optimization could be wise to use findByIdAndUpdate()
 * @link http://mongoosejs.com/docs/api.html#model_Model.findByIdAndUpdate
 */
exports.markRead = function(req, res) {

  var messages = [];

  // Produce an array of messages to be updated
  req.body.messageIds.forEach(function(messageId) {
    messages.push({
      _id: messageId,
      //read: false,

      // Although this isn't in index, but it ensures
      // user has access to update only his/hers own messages
      userTo: req.user.id
    });
  });

  // Mark messages read
  Message.update({
    $or: messages
  },
  {
    read: true
  }, {
    multi: true
  }, function (err) {

    if (err) {
      return res.status(400).send({
        message: errorHandler.getErrorMessage(err)
      });
    }
    else {
      res.status(200).send();
    }

  });

};
