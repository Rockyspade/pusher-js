const Authorizer = require('core/auth/pusher_authorizer').default;
const Errors = require('core/errors');
const EncryptedChannel = require('core/channels/encrypted_channel').default;
const Factory = require('core/utils/factory').default;
const Mocks = require("mocks");
const tweetNacl = require('tweetnacl');
const tweetNaclUtil = require('tweetnacl-util');
const timeout = 5000;

describe("EncryptedChannel", function() {
  var pusher;
  var channel;
  var factorySpy;
  const secretUTF8 = 'It Must Be Thirty Two Characters';
  const secretBytes = tweetNaclUtil.decodeUTF8(secretUTF8)
  const secretBase64 = tweetNaclUtil.encodeBase64(secretBytes);
  const nonceUTF8 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const nonceBytes = tweetNaclUtil.decodeUTF8(nonceUTF8)
  const nonceBase64 = tweetNaclUtil.encodeBase64(nonceBytes);
  const testEncrypt = (payload) => {
    let payloadBytes = tweetNaclUtil.decodeUTF8(JSON.stringify(payload));
    let bytes = tweetNacl.secretbox(payloadBytes, nonceBytes, secretBytes)
    return tweetNaclUtil.encodeBase64(bytes)
  }

  beforeEach(() => {
    pusher = Mocks.getPusher({ foo: "bar" });
    channel = new EncryptedChannel("private-encrypted-test", pusher);
  });

  describe("after construction", function() {
    it("#subscribed should be false", function() {
      expect(channel.subscribed).toEqual(false);
    });

    it("#subscriptionPending should be false", function() {
      expect(channel.subscriptionPending).toEqual(false);
    });

    it("#subscriptionCancelled should be false", function() {
      expect(channel.subscriptionCancelled).toEqual(false);
    });
  });

  describe("#authorize", function() {
    let authorizer;

    beforeEach(() => {
      authorizer = Mocks.getAuthorizer();
      factorySpy = spyOn(Factory, "createAuthorizer").andReturn(authorizer);
    });

    it("should create and call an authorizer", function() {
      channel.authorize("1.23", function() {});
      expect(Factory.createAuthorizer.calls.length).toEqual(1);
      expect(Factory.createAuthorizer).toHaveBeenCalledWith(
        channel,
        { foo: "bar" }
      );
    });

    it("should call back with only authorization data", function() {
      let callback = jasmine.createSpy("callback");
      channel.authorize("1.23", callback);
      expect(callback).not.toHaveBeenCalled();
      authorizer._callback(false, {
        shared_secret: secretBase64,
        foo: "bar"
      });
      expect(callback).toHaveBeenCalledWith(false, { foo: "bar" });
    });

    it("should error if no shared_secret included in auth data", function() {
      let callback = jasmine.createSpy("callback");
      channel.authorize("1.23", callback);
      expect(callback).not.toHaveBeenCalled();
      expect(() => {
        authorizer._callback(false, {
          foo: "bar"
        });
      }).toThrow()
    });

    describe('with custom authorizer', function() {
      beforeEach(() => {
        pusher = Mocks.getPusher({
          authorizer: function(channel, options) {
            return authorizer;
          }
        });
        channel = new EncryptedChannel("private-test-custom-auth", pusher);
        factorySpy.andCallThrough();
      });

      it("should call the authorizer", function() {
        let callback = jasmine.createSpy("callback");
        channel.authorize("1.23", callback);
        authorizer._callback(false, {
          shared_secret: secretBase64,
          foo: "bar"
        });
        expect(callback).toHaveBeenCalledWith(false, { foo: "bar" });
      });
    });
  });

  describe("#trigger", function() {
    let randomBytesSpy;
    beforeEach(() => {
      // in order to trigger encrypted events, we need to get a shared secret
      // from the authorizer.
      let authorizer = Mocks.getAuthorizer();
      factorySpy = spyOn(Factory, "createAuthorizer").andReturn(authorizer);
      let callback = () => {}
      channel.authorize("1.23", callback);
      authorizer._callback(false, {shared_secret: secretBase64, foo: "bar"});
      randomBytesSpy = spyOn(tweetNacl, 'randomBytes').andReturn(nonceBytes)
    });
    it("should raise an exception if the event name does not start with client-", function() {
      expect(function() {
        channel.trigger("whatever", {});
      }).toThrow(jasmine.any(Errors.BadEventName));
    });

    it("should call send_event on connection", function() {
      let payload = {k: "v"};
      let expArg = {
        nonce: nonceBase64,
        ciphertext: testEncrypt(payload)
      };
      channel.trigger("client-test", payload)
      expect(pusher.send_event)
        .toHaveBeenCalledWith("client-test", expArg, "private-encrypted-test");
      });

    it("should return true if connection sent the event", function() {
      pusher.send_event.andReturn(true);
      expect(channel.trigger("client-test", {})).toBe(true);
    });

    it("should return false if authentication hasn't completed", function() {
      let callback = () => {}
      channel.authorize("1.23", callback);
      pusher.send_event.andReturn(false);
      expect(channel.trigger("client-test", {})).toBe(false);
    });

    it("should return false if connection didn't send the event", function() {
      pusher.send_event.andReturn(false);
      expect(channel.trigger("client-test", {})).toBe(false);
    });
  });

  describe("#disconnect", function() {
    it("should set subscribed to false", function() {
      channel.handleEvent("pusher_internal:subscription_succeeded");
      channel.disconnect();
      expect(channel.subscribed).toEqual(false);
    });
  });

  describe("#handleEvent", function() {
    it("should not emit pusher_internal:* events", function() {
      let callback = jasmine.createSpy("callback");
      channel.bind("pusher_internal:test", callback);
      channel.bind_global(callback);

      channel.handleEvent("pusher_internal:test");

      expect(callback).not.toHaveBeenCalled();
    });

    describe("on pusher_internal:subscription_succeeded", function() {
      it("should emit pusher:subscription_succeeded", function() {
        let callback = jasmine.createSpy("callback");
        channel.bind("pusher:subscription_succeeded", callback)
        channel.handleEvent("pusher_internal:subscription_succeeded", "123");
        expect(callback).toHaveBeenCalledWith("123");
      });

      it("should set #subscribed to true", function() {
        channel.handleEvent("pusher_internal:subscription_succeeded", "123")
        expect(channel.subscribed).toEqual(true);
      });

      it("should set #subscriptionPending to false", function() {
        channel.handleEvent("pusher_internal:subscription_succeeded", "123")
        expect(channel.subscriptionPending).toEqual(false);
      });
    });

    describe("pusher_internal:subscription_succeeded but subscription cancelled", function() {
      it("should not emit pusher:subscription_succeeded", function() {
        let callback = jasmine.createSpy("callback");
        channel.bind("pusher:subscription_succeeded", callback);
        channel.cancelSubscription();
        channel.handleEvent("pusher_internal:subscription_succeeded", "123")
        expect(callback).not.toHaveBeenCalled();
      });

      it("should set #subscribed to true", function() {
        channel.cancelSubscription();
        channel.handleEvent("pusher_internal:subscription_succeeded", "123")
        expect(channel.subscribed).toEqual(true);
      });

      it("should set #subscriptionPending to false", function() {
        channel.cancelSubscription();
        channel.handleEvent("pusher_internal:subscription_succeeded", "123");
        expect(channel.subscriptionPending).toEqual(false);
      });

      it("should call #pusher.unsubscribe", function() {
        expect(pusher.unsubscribe).not.toHaveBeenCalled();
        channel.cancelSubscription();
        channel.handleEvent("pusher_internal:subscription_succeeded", "123");
        expect(pusher.unsubscribe).toHaveBeenCalledWith(channel.name);
      });
    });

    describe("on other events", function() {
      beforeEach(() => {
        // in order to decrypt encrypted events, we need to get a shared secret
        // from the authorizer.
        let authorizer = Mocks.getAuthorizer();
        let callback = () => {}
        factorySpy = spyOn(Factory, "createAuthorizer").andReturn(authorizer);
        channel.authorize("1.23", callback);
        authorizer._callback(false, {
          shared_secret: secretBase64,
          foo: "bar"
        });
        let randomBytesSpy = spyOn(tweetNacl, 'randomBytes').andReturn(nonceBytes)
      });
      it("should decrypt the event payload and emit the event", function() {
        let payload = {test: "payload"};
        let encryptedPayload = {
          nonce: nonceBase64,
          ciphertext: testEncrypt(payload)
        };
        let boundCallback = jasmine.createSpy("boundCallback");
        channel.bind("something", boundCallback);
        channel.handleEvent("something", encryptedPayload)
        expect(boundCallback).toHaveBeenCalledWith(payload);
      });
      it("should throw an error if the data payload is not encrypted", function() {
        let payload = {test: "payload"};
        let boundCallback = jasmine.createSpy("boundCallback");
        channel.bind("something", boundCallback);
        expect(() => {
          channel.handleEvent("something", payload)
        }).toThrow();
      });
    });
  });
});
